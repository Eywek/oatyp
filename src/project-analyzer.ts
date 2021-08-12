import { OpenAPIV3 } from 'openapi-types'
import CodeFormatting from './code-formatting'

export interface AnalyzedPathItemObject {
  methods: { [method: string]: AnalyzedOperationObject[] }
}

export interface AnalyzedOperationObject {
  tag: string
  rawTag: string
  operation: OpenAPIV3.OperationObject
  operationId: string
  operationPath: string
  operationMethod: string
  methodName: string
  pathParams: OpenAPIV3.ParameterObject[]
  headerParams: OpenAPIV3.ParameterObject[]
  queryParams: OpenAPIV3.ParameterObject[]
  params: OpenAPIV3.ParameterObject[]
  hasPathParams: boolean
  hasHeaderParams: boolean
  hasQueryParams: boolean
  hasParams: boolean
  isMethodWithData: boolean
  hasRequestBody: boolean
  requestBodySchema?: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject
  successReturnSchema?: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject
  successReturnMimeType?: string | null
  paramSchemas: Record<string, OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject | null>
  referencedTypes: Map<string, OpenAPIV3.SchemaObject>
}

export interface PathOperationsAnalysisContext {
  spec: OpenAPIV3.Document
  path: string
}

export interface OperationAnalysisContext extends PathOperationsAnalysisContext {
  operationId: string
  method: string
}

export interface OperationTagAnalysisContext extends OperationAnalysisContext {
  rawTag: string
}

const METHODS_WITH_DATA: { [name: string]: boolean } = { post: true, patch: true, put: true }
const HTTP_METHODS: (keyof OpenAPIV3.PathItemObject)[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace'
]

export function analyzePathOperations (operations: OpenAPIV3.PathItemObject, context: PathOperationsAnalysisContext) {
  const pathOperations: { [method: string]: AnalyzedOperationObject[] } = {}

  for (const method of HTTP_METHODS) {
    const operation = operations[method] as OpenAPIV3.OperationObject
    if (!operation) continue
    let operationId = operation.operationId
    if (!operationId) {
      // generate an operationId
      operationId = context.path.split('/').slice(-1).join('') + '_' + method
    }
    pathOperations[method] = analyzeOperation(operation, {
      ...context,
      operationId,
      method
    })
  }

  const result: AnalyzedPathItemObject = {
    methods: pathOperations
  }
  return result
}

function analyzeOperation (operation: OpenAPIV3.OperationObject, context: OperationAnalysisContext) {
  // We add the operation method for each tag
  // by default we fallback to `default` tag if not provided
  const tags = operation.tags && operation.tags.length > 0 ? operation.tags : ['default']

  return tags
    .map((rawTag) => analyzeOperationTag(operation, { ...context, rawTag }))
    .filter((v) => !!v) as AnalyzedOperationObject[]
}

function analyzeOperationTag (operation: OpenAPIV3.OperationObject, context: OperationTagAnalysisContext) {
  const responses = operation.responses
  if (typeof responses === 'undefined' || Object.keys(responses).length === 0) return null

  const operationId = context.operationId
  const methodName = CodeFormatting.camelCase(operationId)
  const tag = CodeFormatting.pascalCase(context.rawTag)

  const analysis: AnalyzedOperationObject = {
    rawTag: context.rawTag,
    tag,
    operation,
    operationId,
    operationPath: context.path,
    operationMethod: context.method,
    methodName,
    pathParams: [],
    headerParams: [],
    queryParams: [],
    params: [],
    hasPathParams: false,
    hasHeaderParams: false,
    hasQueryParams: false,
    hasParams: false,
    isMethodWithData: !!METHODS_WITH_DATA[context.method],
    hasRequestBody: false,
    successReturnMimeType: null,
    paramSchemas: {} as Record<string, OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject | null>,
    referencedTypes: new Map<string, OpenAPIV3.SchemaObject>()
  }

  const [, successResponseObject] = responses
    ? (Object.entries(responses)[0] as [string, OpenAPIV3.ResponseObject])
    : [null, { content: null }]

  let successResponse: OpenAPIV3.MediaTypeObject | null = null

  if (successResponseObject.content) {
    analysis.successReturnMimeType = Object.keys(successResponseObject.content)[0]
    if (successResponseObject.content['application/json']) {
      successResponse = successResponseObject.content['application/json']
    }
  }

  if (analysis.isMethodWithData) {
    analysis.requestBodySchema = (operation.requestBody as OpenAPIV3.RequestBodyObject | undefined)?.content[
      'application/json'
    ]?.schema
    analysis.hasRequestBody = !!analysis.requestBodySchema
    if (analysis.requestBodySchema) {
      trackReferences(analysis.requestBodySchema, analysis.referencedTypes, context.spec)
    }
  }

  if (successResponse && successResponse.schema) {
    analysis.successReturnSchema = successResponse.schema as OpenAPIV3.SchemaObject
    if (analysis.successReturnSchema) {
      trackReferences(analysis.successReturnSchema, analysis.referencedTypes, context.spec)
    } else {
      // There's a schema but no type?
    }
  }

  for (const param of operation.parameters ?? []) {
    const config = param as OpenAPIV3.ParameterObject
    if (!config.in) continue
    analysis.params.push(config)
    switch (config.in) {
      case 'path':
        analysis.pathParams.push(config)
        break
      case 'header':
        analysis.headerParams.push(config)
        break
      case 'query':
        analysis.queryParams.push(config)
        break
    }
    const paramSchema = config.schema as OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject
    if (paramSchema) {
      if ('$ref' in paramSchema) {
        const refType = CodeFormatting.retrieveRef(paramSchema.$ref, context.spec)
        if (refType) {
          trackReferences(refType, analysis.referencedTypes, context.spec)
        }
      }
      analysis.paramSchemas[config.name] = paramSchema
    } else analysis.paramSchemas[config.name] = null
  }
  analysis.hasPathParams = !!(analysis.pathParams && analysis.pathParams.length)
  analysis.hasHeaderParams = !!(analysis.headerParams && analysis.headerParams.length)
  analysis.hasQueryParams = !!(analysis.queryParams && analysis.queryParams.length)
  analysis.hasParams = analysis.hasPathParams || analysis.hasHeaderParams || analysis.hasQueryParams

  return analysis
}

function trackReferences (
  referencedSchema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject,
  referencedTypes: Map<string, OpenAPIV3.SchemaObject>,
  spec: OpenAPIV3.Document
) {
  const schemas = getSchemas(referencedSchema, spec)

  function handleSchema (schema: OpenAPIV3.SchemaObject | (OpenAPIV3.SchemaObject | string)[] | string | null) {
    if (!schema) return
    if (typeof schema === 'string') {
      referencedTypes.set(schema, {})
    } else if (Array.isArray(schema)) {
      schema.forEach(handleSchema)
    } else {
      referencedTypes.set(schema.type ?? 'basdasd', schema)
    }
  }
  handleSchema(schemas)
}

function getSchemas (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject,
  spec: OpenAPIV3.Document
): string[] | string | null {
  function notEmpty<TValue> (value: TValue | null | undefined): value is TValue {
    return value !== null && value !== undefined
  }
  // Note: we use another to function to avoid needing to pass every arguments for recursive calls
  function getSchema (
    schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject
  ): string[] | string | null {
    if ('$ref' in schema) {
      return CodeFormatting.extractRef(schema.$ref)
    }
    if (schema.allOf) {
      const types = schema.allOf
        .flatMap((subschema) => {
          return getSchema(subschema)
        })
        .filter(notEmpty)
      if (types.length < 2) {
        return types[0]
      }
      return types
    }
    if (schema.oneOf) {
      const types = schema.oneOf
        .flatMap((subschema) => {
          return getSchema(subschema)
        })
        .filter(notEmpty)
      if (types.length === 1) {
        return types[0]
      }
      return types
    }
    if (schema.type === 'array') {
      return getSchema(schema.items)
    }
    if (schema.type === 'object') {
      const types = Object.entries(schema.properties || {})
        .flatMap(([key, propSchema]) => {
          return getSchema(propSchema)
        })
        .filter(notEmpty)
      if (types.length === 1) {
        return types[0]
      }
      return types
    }
    if (schema.type === 'boolean') {
      return null
    }
    if (schema.type === 'integer' || schema.type === 'number') {
      return null
    }
    if (schema.format === 'date' || schema.format === 'date-time') {
      return null
    }
    if (schema.type === 'string') {
      return null
    }
    return null
  }
  return getSchema(schema)
}
