import { Project, ts } from 'ts-morph'
import path from 'path'
import YAML from 'yamljs'
import { OpenAPIV3 } from 'openapi-types'
import fs from 'fs'
import { generateTypes } from './types'
import { generateApi } from './api'

export type GenerateConfig = {
  outDir: string
  openapiFilePath: string
  removeTagFromOperationId?: boolean
  tsConfig?: ts.CompilerOptions
}

function haveReadonlyOrWriteonly (prop?: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject): boolean {
  if (typeof prop === 'undefined' || '$ref' in prop) { // ignore here
    return false
  }
  return prop.readOnly || // if this is a property
    prop.writeOnly || // if this is a property
    // handle for properties
    Object.values(prop.properties ?? {}).some(prop => haveReadonlyOrWriteonly(prop)) ||
    prop.allOf?.some(prop => haveReadonlyOrWriteonly(prop)) ||
    prop.anyOf?.some(prop => haveReadonlyOrWriteonly(prop)) ||
    prop.oneOf?.some(prop => haveReadonlyOrWriteonly(prop)) ||
    (typeof prop.additionalProperties === 'object' && haveReadonlyOrWriteonly(prop.additionalProperties)) ||
    haveReadonlyOrWriteonly(prop.not) ||
    ('items' in prop && haveReadonlyOrWriteonly(prop.items))
}
function haveReadonlyOrWriteonlyPropsInContents (contents: Record<string, OpenAPIV3.MediaTypeObject>) {
  return Object.values(contents)
    .some((content) => {
      if (typeof content.schema === 'undefined' || '$ref' in content.schema) { // we ignore refs here
        return false
      }
      return haveReadonlyOrWriteonly(content.schema)
    })
}

export async function generate (config: GenerateConfig) {
  // Init compiler
  const project = new Project({
    compilerOptions: {
      outDir: config.outDir,
      declaration: true,
      ...config.tsConfig
    }
  })
  const typesSourceFile = project.createSourceFile('definitions.ts')
  const apiSourceFile = project.createSourceFile('api.ts')

  // Load spec
  const ext = path.extname(config.openapiFilePath)
  let spec: OpenAPIV3.Document
  if (ext === '.yaml' || ext === '.yml') {
    spec = YAML.load(config.openapiFilePath)
  } else {
    const fileContent = await fs.promises.readFile(config.openapiFilePath)
    spec = JSON.parse(fileContent.toString())
  }

  // We need to detect if the openapi file use readOnly or writeOnly modifiers
  // if it's used we will add some trick to handle it (which can break recursive types)
  const haveReadonlyOrWriteonlyPropsInPaths = Object.values(spec.paths).some((path) => {
    return (['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const)
      .some((method) => {
        if (typeof path[method] === 'undefined') return false // ignore if we don't have the method defined
        const body = path[method]!.requestBody
        if (typeof body !== 'undefined' && !('$ref' in body)) { // if we don't have a body or this is a ref we ignore
          const havePropsInBody = haveReadonlyOrWriteonlyPropsInContents(body.content)
          if (havePropsInBody === true) return true
        }
        return Object.values(path[method]!.responses ?? {}).some((response) => { // we handle responses
          if ('$ref' in response) { // we ignore ref here
            return false
          }
          return haveReadonlyOrWriteonlyPropsInContents(response.content ?? {})
        })
      })
  })
  const haveReadonlyOrWriteonlyPropsInSchemas = Object.values(spec.components?.schemas ?? {}).some((schema) => {
    if ('$ref' in schema) { // ignore, will be handled after
      return false
    }
    return haveReadonlyOrWriteonly(schema)
  })
  const haveReadonlyOrWriteonlyProps = haveReadonlyOrWriteonlyPropsInPaths || haveReadonlyOrWriteonlyPropsInSchemas

  // Generate types
  await generateTypes(typesSourceFile, spec, {
    addReadonlyWriteonlyModifiers: haveReadonlyOrWriteonlyProps === true
  })

  // Generate api
  await generateApi(apiSourceFile, spec, {
    removeTagFromOperationId:
      typeof config.removeTagFromOperationId === 'undefined' ? false : config.removeTagFromOperationId,
    addReadonlyWriteonlyModifiers: haveReadonlyOrWriteonlyProps === true
  })

  // Emit typescript files
  const fileSystem = project.getFileSystem()
  for (const sourceFile of [typesSourceFile, apiSourceFile]) {
    const relativePath = sourceFile.getRelativePathTo(sourceFile)
    const outputPath = path.join(config.outDir, relativePath);
    const outputPathDirectory = path.dirname(outputPath);
    if (!await fileSystem.directoryExists(outputPathDirectory)) {
      await fileSystem.mkdir(outputPathDirectory);
    }
    await fileSystem.writeFile(path.join(config.outDir, relativePath), '/* tslint:disable */\n/* eslint-disable */\n\n' + sourceFile.getFullText())
  }
}
