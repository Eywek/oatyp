import { MethodDeclaration, Scope, SourceFile, WriterFunctionOrValue, Writers } from 'ts-morph'
import { OpenAPIV3 } from 'openapi-types'
import { generateTypeForSchema, writeWriterOrString, extractRef } from './types'
import type { WriterFunctionOrString } from './types'

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

export interface GenerateApiOptions {
  removeTagFromOperationId: boolean
  addReadonlyWriteonlyModifiers: boolean
}

interface AnalyzedPathItemObject {
  methods: { [method: string]: AnalyzedOperationObject[] }
}

interface AnalyzedOperationObject {
  tag: string
  rawTag: string
  operation: OpenAPIV3.OperationObject
  operationId: string
  operationPath: string
  operationMethod: string
  methodName: string
  normalizedGetterName: string
  pathParams: OpenAPIV3.ParameterObject[]
  headerParams: OpenAPIV3.ParameterObject[]
  queryParams: OpenAPIV3.ParameterObject[]
  params: OpenAPIV3.ParameterObject[]
  hasPathParams: boolean
  hasHeaderParams: boolean
  hasQueryParams: boolean
  hasParams: boolean
  isMethodWithData: boolean
  hasBody: boolean
  bodySchema?: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject
  bodyType: WriterFunctionOrString | null
  returnType: WriterFunctionOrString | null
  paramTypes: Record<string, WriterFunctionOrValue>
  referencedTypes: Map<string, OpenAPIV3.SchemaObject>
}

interface PathOperationsAnalysisContext {
  spec: OpenAPIV3.Document
  options: GenerateApiOptions
  path: string
}

interface OperationAnalysisContext extends PathOperationsAnalysisContext {
  operationId: string
  method: string
}

interface OperationTagAnalysisContext extends OperationAnalysisContext {
  rawTag: string
}

function analyzePathOperations (operations: OpenAPIV3.PathItemObject, context: PathOperationsAnalysisContext) {
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
  const methodName = camelCase(operationId)
  const tag = pascalCase(context.rawTag)

  const analysis: AnalyzedOperationObject = {
    rawTag: context.rawTag,
    tag,
    operation,
    operationId,
    operationPath: context.path,
    operationMethod: context.method,
    methodName,
    normalizedGetterName: methodName.replace(new RegExp(tag + '_?', 'gi'), ''),
    pathParams: [],
    headerParams: [],
    queryParams: [],
    params: [],
    hasPathParams: false,
    hasHeaderParams: false,
    hasQueryParams: false,
    hasParams: false,
    isMethodWithData: !!METHODS_WITH_DATA[context.method],
    hasBody: false,
    returnType: null,
    bodyType: null,
    paramTypes: {} as Record<string, WriterFunctionOrValue>,
    referencedTypes: new Map<string, OpenAPIV3.SchemaObject>()
  }

  const [, successResponseObject] = responses
    ? (Object.entries(responses)[0] as [string, OpenAPIV3.ResponseObject])
    : [null, { content: null }]
  const successResponse = successResponseObject.content && successResponseObject.content['application/json']

  if (analysis.isMethodWithData) {
    analysis.bodySchema = (operation.requestBody as OpenAPIV3.RequestBodyObject | undefined)?.content[
      'application/json'
    ]?.schema
    analysis.hasBody = !!analysis.bodySchema
    if (analysis.bodySchema) {
      trackReferences(analysis.bodySchema, analysis.referencedTypes, context.spec)
      analysis.bodyType = generateTypeForSchema(
        analysis.bodySchema,
        context.spec,
        '', // "Types.",
        context.options.addReadonlyWriteonlyModifiers,
        {
          writeonly: true,
          readonly: false,
          addReaonlyAndWriteonlyFilters: false
        }
      )
    }
  }

  if (successResponse && successResponse.schema) {
    const successSchema = successResponse.schema as OpenAPIV3.SchemaObject
    if (successSchema.type) {
      trackReferences(successSchema, analysis.referencedTypes, context.spec)
      analysis.returnType = generateTypeForSchema(
        successSchema,
        context.spec,
        '', // "Types.",
        context.options.addReadonlyWriteonlyModifiers,
        {
          writeonly: false,
          readonly: true,
          addReaonlyAndWriteonlyFilters: false
        }
      )
    } else {
      // There's a schema but no type?
    }
  } else if (successResponseObject.content) {
    const responseMimeType = Object.keys(successResponseObject.content)[0]
    switch (responseMimeType) {
      case 'text/plain':
        analysis.returnType = 'string'
        break
      default:
        // Unknown type
        analysis.returnType = 'unknown'
        break
    }
  } else {
    // No response content
    analysis.returnType = 'void'
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
    const paramSchema = config.schema as OpenAPIV3.SchemaObject
    if (paramSchema) {
      analysis.paramTypes[config.name] = generateTypeForSchema(paramSchema, context.spec, '') // "Types.");
      // if (paramSchema.type) analysis.referencedTypes.set(paramSchema.type, paramSchema);
    } else analysis.paramTypes[config.name] = 'unknown'
  }
  analysis.hasPathParams = !!(analysis.pathParams && analysis.pathParams.length)
  analysis.hasHeaderParams = !!(analysis.headerParams && analysis.headerParams.length)
  analysis.hasQueryParams = !!(analysis.queryParams && analysis.queryParams.length)
  analysis.hasParams = analysis.hasPathParams || analysis.hasHeaderParams || analysis.hasQueryParams

  return analysis
}

function getAllReferencedTypes (analyzedPaths: AnalyzedPathItemObject[]) {
  const referencedTypeNames: Record<string, boolean> = {}
  analyzedPaths.forEach((path) => {
    Object.values(path.methods).forEach((methodOperations) => {
      methodOperations.forEach((analysis) => {
        Array.from(analysis.referencedTypes.keys()).forEach((key) => {
          referencedTypeNames[key] = true
        })
      })
    })
  })
  return Object.keys(referencedTypeNames)
}

function populateOperationMethod (methodDeclaration: MethodDeclaration, analysis: AnalyzedOperationObject) {
  // Add parameters
  if (analysis.hasParams) {
    const paramsProperties = analysis.params.reduce((params, param) => {
      const paramType = analysis.paramTypes[param.name]
      const questionToken = param.required === false ? '?' : ''
      params[`${param.name}${questionToken}`] = paramType
      return params
    }, {} as Record<string, WriterFunctionOrValue>)
    methodDeclaration.addParameter({
      name: 'params',
      type: Writers.object(paramsProperties)
    })
  }
  // Add body
  if (analysis.bodyType) {
    methodDeclaration.addParameter({
      name: 'data',
      type: analysis.bodyType
    })
  }
  // Add axios config options params
  methodDeclaration.addParameter({
    name: 'options',
    type: 'AxiosRequestConfig',
    hasQuestionToken: true
  })
  // Axios call
  methodDeclaration.setBodyText(
    Writers.returnStatement((writer) => {
      if (analysis.returnType) {
        writer.write(`this.axios.${analysis.operationMethod}<`)
        writeWriterOrString(writer, analysis.returnType)
        writer.write('>(\n')
      } else {
        writer.write(`this.axios.${analysis.operationMethod}(\n`)
      }
      // Endpoint
      writer.indent(() => {
        writer.quote(analysis.operationPath)
        if (analysis.hasPathParams) {
          // We need to replace url parameters in the endpoint
          for (const param of analysis.pathParams) {
            writer.write(`.replace(/{${param.name}}/, String(params[`).quote(param.name).write(']))')
          }
        }
        // Data
        if (analysis.isMethodWithData) {
          if (analysis.bodyType) {
            writer.write(', data')
          } else {
            writer.write(', {}')
          }
        }
        // Axios config
        const needsAssign = analysis.hasHeaderParams || analysis.hasQueryParams
        if (needsAssign) {
          writer
            .write(',')
            .writeLine('Object.assign(')
            .indent(() => {
              writer
                .writeLine('{},')
                .inlineBlock(() => {
                  if (analysis.hasHeaderParams) {
                    writer.writeLine('headers: ' + generatePickString(analysis.headerParams) + ',')
                  }
                  if (analysis.hasQueryParams) {
                    writer.writeLine('params: ' + generatePickString(analysis.queryParams) + ',')
                  }
                })
                .write(',')
                .writeLine('options')
            })
          writer.writeLine(')') // Assign ending paren
        } else {
          writer.write(', options')
        }
      })
      writer.write(')') // Call ending paren
    })
  )
}

export async function generateApi (file: SourceFile, spec: OpenAPIV3.Document, opts: GenerateApiOptions): Promise<void> {
  // Analyze all the operations in advance
  const pathsAnalysis = Object.entries(spec.paths).map(([path, operations]) => {
    return analyzePathOperations(operations, {
      spec,
      options: opts,
      path
    })
  })

  const referencedTypes = getAllReferencedTypes(pathsAnalysis)

  // Imports
  file.addImportDeclaration({
    defaultImport: 'axios',
    namedImports: ['AxiosInstance', 'AxiosRequestConfig'],
    moduleSpecifier: 'axios'
  })
  if (referencedTypes.length) {
    file.addImportDeclaration({
      moduleSpecifier: './definitions',
      namedImports: referencedTypes,
      isTypeOnly: true
    })
  }
  // Exports types
  // Disabled due to indent issues
  // file.addExportDeclaration({
  //   namedExports: referencedTypes,
  //   isTypeOnly: true
  // });

  // Init class
  const classDeclaration = file.addClass({
    isDefaultExport: true
  })
  const classDeclarationMethods = new Map<string, Record<string, WriterFunctionOrValue>>()

  // Constructor
  classDeclaration.addProperty({
    name: 'axios',
    scope: Scope.Public,
    type: 'AxiosInstance'
  })
  classDeclaration
    .addConstructor({
      parameters: [
        {
          name: 'configOrInstance',
          type: 'AxiosRequestConfig | AxiosInstance'
        }
      ]
    })
    .setBodyText((writer) => {
      writer.write("this.axios = 'interceptors' in configOrInstance").indent(() => {
        writer.writeLine('? configOrInstance')
        writer.writeLine(': axios.create(configOrInstance)')
      })
    })

  // Operations
  for (const operationsAnalysis of pathsAnalysis) {
    for (const analyzedOperations of Object.values(operationsAnalysis.methods)) {
      for (const analysis of analyzedOperations) {
        // Initialize object for tag
        if (classDeclarationMethods.has(analysis.tag) === false) {
          classDeclarationMethods.set(analysis.tag, {})
        }
        const tagObject = classDeclarationMethods.get(analysis.tag)!

        // Handle operation method
        const methodDeclaration = classDeclaration.addMethod({
          scope: Scope.Private,
          name: analysis.methodName
        })

        populateOperationMethod(methodDeclaration, analysis)

        // Add to getter
        const getterName = opts.removeTagFromOperationId ? analysis.normalizedGetterName : analysis.methodName
        tagObject[getterName] = `this.${analysis.methodName}.bind(this)`
      }
    }
  }

  // Add get accessors with objects
  for (const [tag, object] of classDeclarationMethods.entries()) {
    classDeclaration
      .addGetAccessor({ name: pascalCase(tag) })
      .setBodyText(Writers.returnStatement(Writers.object(object)))
  }

  // Utils
  const needsPickFunction = pathsAnalysis.some((e) =>
    Object.values(e.methods).some((m) => m.some((o) => o.hasHeaderParams || o.hasQueryParams))
  )
  if (needsPickFunction) {
    file
    .addFunction({
      name: 'pick',
      parameters: [
        { name: 'obj', type: 'T' },
        { name: 'keys', type: 'K[]', isRestParameter: true }
      ],
      typeParameters: [{ name: 'T' }, { name: 'K', constraint: 'keyof T' }]
    })
    .setReturnType('Pick<T, K>')
    .setBodyText((writer) => {
      writer.writeLine('const ret: Pick<T, K> = {} as Pick<T, K>;')
      writer.write('keys.forEach(key => {')
      writer.indent(() => {
        writer.writeLine('if (key in obj)')
        writer.indent(() => {
          writer.writeLine('ret[key] = obj[key];')
        })
      })
      writer.writeLine('});')
      writer.writeLine('return ret;')
    })
  }
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
  function generate (
    schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject
  ): string[] | string | null {
    if ('$ref' in schema) {
      return extractRef(schema.$ref)
    }
    if (schema.allOf) {
      const types = schema.allOf
        .flatMap((subschema) => {
          return generate(subschema)
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
          return generate(subschema)
        })
        .filter(notEmpty)
      if (types.length < 2) {
        return types[0]
      }
      return types
    }
    if (schema.type === 'array') {
      return generate(schema.items)
    }
    if (schema.type === 'object') {
      return null
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
  return generate(schema)
}

function camelCase (str: string) {
  const camel = str.replace(/\W+(.)/g, (match, chr) => chr.toUpperCase())
  return camel.charAt(0).toLowerCase() + camel.slice(1)
}

function pascalCase (str: string) {
  const camel = camelCase(str)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

function generatePickString (params: OpenAPIV3.ParameterObject[]) {
  if (!params || params.length === 0) return '{}'
  return `pick(params, "${params.map(p => p.name).join('", "')}")`
}
