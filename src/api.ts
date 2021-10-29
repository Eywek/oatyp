import { MethodDeclaration, Scope, SourceFile, WriterFunctionOrValue, Writers } from 'ts-morph'
import { analyzePathOperations } from './project-analyzer'
import CodeFormatting from './code-formatting'
import CodeGen from './code-gen'
import type { OpenAPIV3 } from 'openapi-types'
import type { AnalyzedPathItemObject, AnalyzedOperationObject } from './project-analyzer'

export interface GenerateApiContext {
  file: SourceFile
  spec: OpenAPIV3.Document
  options: GenerateApiOptions
}

export interface GenerateApiOptions {
  removeTagFromOperationId: boolean
  alwaysAddParamsMethodParameter: boolean
  addReadonlyWriteonlyModifiers: boolean
}

function getReferencedTypesFromPaths (analyzedPaths: AnalyzedPathItemObject[]) {
  const referencedTypeNames = new Set<string>()
  analyzedPaths.forEach((path) => {
    Object.values(path.methods).forEach((methodOperations) => {
      methodOperations.forEach((analysis) => {
        Array.from(analysis.referencedTypes.keys()).forEach((key) => {
          referencedTypeNames.add(key)
        })
      })
    })
  })
  return Array.from(referencedTypeNames)
    .map(CodeFormatting.makeNameSafeForIdentifier)
}

function populateOperationMethod (methodDeclaration: MethodDeclaration, analysis: AnalyzedOperationObject, context: GenerateApiContext) {
  // Add parameters
  if (analysis.hasParams) {
    const paramsProperties = analysis.params.reduce((params, param) => {
      const paramSchema = analysis.paramSchemas[param.name]
      const paramType = paramSchema
        ? CodeGen.generateTypeForSchema(paramSchema, context.spec, '')
        // If there's no schema for the parameter, make it unknown
        : 'unknown'
      const questionToken = param.required === false ? '?' : ''
      params[`'${param.name}'${questionToken}`] = paramType
      return params
    }, {} as Record<string, WriterFunctionOrValue>)
    methodDeclaration.addParameter({
      name: 'params',
      type: Writers.object(paramsProperties)
    })
  } else if (context.options.alwaysAddParamsMethodParameter) {
    // We always add params to ensure consistency
    methodDeclaration.addParameter({
      name: 'params',
      type: 'Record<string, never>'
    })
  }
  // Add body
  if (analysis.requestBodySchema) {
    const requestBodyType = CodeGen.generateTypeForSchema(
      analysis.requestBodySchema,
      context.spec,
      '', // "Types.",
      context.options.addReadonlyWriteonlyModifiers,
      {
        writeonly: true,
        readonly: false,
        addReadonlyAndWriteonlyFilters: false
      }
    )
    methodDeclaration.addParameter({
      name: 'data',
      type: requestBodyType
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
      const returnType = analysis.successReturnSchema
        ? CodeGen.generateTypeForSchema(
            analysis.successReturnSchema,
            context.spec,
            '', // "Types.",
            context.options.addReadonlyWriteonlyModifiers,
          {
            writeonly: false,
            readonly: true,
            addReadonlyAndWriteonlyFilters: false
          }
          )
        : null
      if (returnType) {
        writer.write(`this.axios.${analysis.operationMethod}<${returnType}>(\n`)
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
          if (analysis.hasRequestBody) {
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
                    writer.writeLine('headers: ' + CodeGen.generatePickString(analysis.headerParams) + ',')
                  }
                  if (analysis.hasQueryParams) {
                    writer.writeLine('params: ' + CodeGen.generatePickString(analysis.queryParams) + ',')
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
  const genContext: GenerateApiContext = {
    file,
    spec,
    options: opts
  }

  // Analyze all the operations in advance
  const pathsAnalysis = Object.entries(spec.paths).map(
    ([path, operations]) => analyzePathOperations(operations, { spec, path })
  )

  const referencedTypes = getReferencedTypesFromPaths(pathsAnalysis)

  if (opts.addReadonlyWriteonlyModifiers) {
    referencedTypes.push(
      'WithoutReadonly',
      'WithoutWriteonly'
    )
  }

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
  // Exports all types
  // because some types could be needed but no referenced in the swagger if inlined
  // note: this is not typeOnly because we could have enum
  file.addExportDeclaration({
    moduleSpecifier: './definitions'
  })

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

        populateOperationMethod(methodDeclaration, analysis, genContext)

        // Add to getter
        const getterName = opts.removeTagFromOperationId
          ? CodeFormatting.removeTagFromMethodName(analysis.tag, analysis.methodName)
          : analysis.methodName
        tagObject[getterName] = `this.${analysis.methodName}.bind(this)`
      }
    }
  }

  // Add get accessors with objects
  for (const [tag, object] of classDeclarationMethods.entries()) {
    classDeclaration
      .addGetAccessor({ name: CodeFormatting.pascalCase(tag) })
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
        writer.writeLine('if (obj && Object.keys(obj).includes(key as string))')
        writer.indent(() => {
          writer.writeLine('ret[key] = obj[key];')
        })
      })
      writer.writeLine('});')
      writer.writeLine('return ret;')
    })
  }
}
