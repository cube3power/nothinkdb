/* eslint no-shadow: 0, no-param-reassign: 0 */
import r from 'rethinkdb';
import Joi from 'joi';
import _ from 'lodash';
import assert from 'assert';
import Link from './Link';
const debug = require('debug')('nothinkdb');

function parseRelationOptions(options) {
  return _.chain(options)
    .omitBy((value, key) => !_.startsWith(key, '_'))
    .reduce((memo, value, key) => ({
      [key.slice(1)]: value,
    }), {})
    .value();
}

export default class Table {
  static pk = 'id';

  constructor(options = {}) {
    const { tableName, pk, schema, relations, index } = Joi.attempt(options, {
      tableName: Joi.string().required(),
      pk: Joi.string().default(this.constructor.pk),
      schema: Joi.func().required(),
      relations: Joi.func().default(() => () => ({}), 'relation'),
      index: Joi.object().default({}, 'index'),
    });

    this.tableName = tableName;
    this.pk = pk;
    this.schema = schema;
    this._schema = null;
    this.relations = relations;
    this._relations = null;
    this.index = index;
  }

  init() {
    this._schema = this.schema();
    this._relations = this.relations();
  }

  getSchema() {
    if (!this._schema) this.init();
    return this._schema;
  }

  getRelations() {
    if (!this._relations) this.init();
    return this._relations;
  }

  metaFields(metaKey) {
    return _.chain(this.getSchema())
      .omitBy(schema => !_.find(schema._meta, meta => _.has(meta, metaKey)))
      .keys()
      .value();
  }

  validate(data = null) {
    return !Joi.validate(data, this.getSchema()).error;
  }

  attempt(data = null) {
    return Joi.attempt(data, this.getSchema());
  }

  create(data = null) {
    return this.attempt(data);
  }

  hasField(fieldName) {
    return _.has(this.getSchema(), fieldName);
  }

  assertField(fieldName) {
    return assert.ok(this.hasField(fieldName), `Field '${fieldName}' is unspecified in table '${this.tableName}'.`);
  }

  getField(fieldName) {
    this.assertField(fieldName);
    return this.getSchema()[fieldName];
  }

  getForeignKey(options = {}) {
    const { fieldName = this.pk, isManyToMany = false } = options;
    const field = this.getField(fieldName);

    if (isManyToMany) {
      return field.required().meta({ index: true });
    }
    return field.allow(null).default(null).meta({ index: true });
  }

  linkTo(targetTable, leftField, options = {}) {
    const { index = targetTable.pk } = options;
    return new Link({
      left: { table: this, field: leftField },
      right: { table: targetTable, field: index },
    });
  }

  linkedBy(targetTable, leftField, options) {
    return targetTable.linkTo(this, leftField, options);
  }

  async sync(connection) {
    debug(`sync ${connection.db}.${this.tableName}...`);
    await this.ensureTable(connection);
    await this.ensureAllIndexes(connection);
    debug(`[done] sync ${connection.db}.${this.tableName}`);
  }

  async ensureTable(connection) {
    debug(`ensureTable ${connection.db}.${this.tableName}...`);
    await r.branch(
      r.tableList().contains(this.tableName).not(),
      r.tableCreate(this.tableName),
      null
    ).run(connection);
    debug(`[done] ensureTable ${connection.db}.${this.tableName}`);
  }

  async ensureAllIndexes(connection) {
    debug(`ensureAllIndex ${connection.db}.${this.tableName}...`);
    const indexFields = [
      ...this.metaFields('index'),
      ...this.metaFields('unique'),
    ];

    await indexFields.reduce((promise, indexName) => {
      return promise.then(() => this.ensureIndex(connection, indexName));
    }, Promise.resolve());

    await _.reduce(this.index, (promise, option, indexName) => {
      return promise.then(() => {
        return option === true ?
          this.ensureIndex(connection, indexName) :
          this.ensureIndex(connection, indexName, option);
      });
    }, Promise.resolve());
    debug(`[done] ensureAllIndex ${connection.db}.${this.tableName}`);
  }

  async ensureIndex(connection, indexName, option) {
    debug(`ensureIndex ${connection.db}.${this.tableName} ${indexName}...`);
    if (this.pk === indexName) return;
    await r.branch(
      this.query().indexList().contains(indexName).not(),
      this.query().indexCreate(indexName, option),
      null
    ).run(connection);
    await this.query().indexWait(indexName).run(connection);
    debug(`[done] ensureIndex ${connection.db}.${this.tableName} ${indexName}`);
  }

  query() {
    return r.table(this.tableName);
  }

  insert(data, ...options) {
    const insertData = { ...data };
    if (this.hasField('createdAt')) {
      insertData.createdAt = r.now();
    }
    return this.assertIntegrate(data)
    .do(() => this.query().insert(data, ...options));
  }

  get(pk) {
    return this.query().get(pk);
  }

  update(pk, data, ...options) {
    const updateData = { ...data };
    if (this.hasField('updatedAt')) {
      updateData.updatedAt = r.now();
    }
    return this.assertIntegrate(data)
    .do(() => {
      const selectionQuery = _.isArray(pk) ?
        this.query().getAll(...pk) :
        this.query().get(pk);
      return selectionQuery.update(updateData, ...options);
    });
  }

  assertIntegrate(data) {
    const uniqueFields = this.metaFields('unique');
    if (_.isEmpty(uniqueFields)) return r.expr(true);

    const uniqueData = _.pick(data, uniqueFields);
    if (_.isEmpty(uniqueData)) return r.expr(true);

    return _.reduce(uniqueData, (expr, val, key) => {
      return expr.do(() => {
        if (_.isUndefined(val) || _.isNull(val)) return r.expr(null);

        return r.branch(
          this.query().getAll(val, { index: key }).count().gt(0),
          r.error(`"${key}" field is unique in "${this.tableName}" table. { "${key}": "${val}" } already exist.`),
          null
        );
      });
    }, r.expr({}));
  }

  delete(pk, ...options) {
    return this.query().get(pk).delete(...options);
  }

  getRelation(relation) {
    const relationObj = this.getRelations()[relation];
    assert.ok(relationObj, `Relation '${this.tableName}.${relation}' is not exist.`);
    return relationObj;
  }

  withJoin(query, relations) {
    const joinedQuery = query.merge(row =>
      _.chain(relations)
        .omitBy((relations, key) => _.startsWith(key, '_'))
        .reduce((joinObject, relations, key) => {
          let relatedQuery = this.getRelated(row, key);

          // if nested
          if (_.isObject(relations) && !_.isEmpty(relations)) {
            const { targetTable } = this.getRelation(key);
            relatedQuery = targetTable.withJoin(relatedQuery, relations);
          }

          return {
            ...joinObject,
            [key]: relatedQuery,
          };
        }, {})
        .value()
    );

    return r.branch(
      query.typeOf().eq('NULL').not(),
      joinedQuery,
      query
    );
  }

  getRelated(pk, relationName, options = {}) {
    const relation = this.getRelation(relationName);
    const query = this.queryRelated(pk, relationName, options);
    return relation.coerceType(query);
  }

  queryRelated(pk, relationName, options = {}) {
    const relation = this.getRelation(relationName);
    const index = relation.index(pk);
    return relation.query(index, parseRelationOptions(options));
  }

  createRelation(relationName, onePk, otherPk) {
    const relation = this.getRelation(relationName);
    return relation.create(onePk, otherPk);
  }

  removeRelation(relationName, onePk, otherPk) {
    const relation = this.getRelation(relationName);
    return relation.remove(onePk, otherPk);
  }

  hasRelation(relationName, onePk, otherPk) {
    const relation = this.getRelation(relationName);
    return relation.has(onePk, otherPk);
  }
}
