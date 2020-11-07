import { Project, ts } from 'ts-morph'
import path from 'path'
import YAML from 'yamljs'
import { OpenAPIV3 } from 'openapi-types'
import fs from 'fs'
import { generateTypes } from './types'
import { generateApi } from './api'

export type GenerateConfig = {
  outDir: string,
  openapiFilePath: string,
  tsConfig?: ts.CompilerOptions
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

  // Generate types
  await generateTypes(typesSourceFile, spec)

  // Generate api
  await generateApi(apiSourceFile, spec)

  // Emit files
  // await project.emit()

  // Emit typescript files
  const fileSystem = project.getFileSystem()
  for (const sourceFile of [typesSourceFile, apiSourceFile]) {
    const relativePath = sourceFile.getRelativePathTo(sourceFile)
    await fileSystem.writeFile(path.join(config.outDir, relativePath), '/* tslint:disable */\n/* eslint-disable */\n\n' + sourceFile.getFullText())
  }
}
