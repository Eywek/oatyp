import { Project, ts } from 'ts-morph'

export type GenerateConfig = {
  outDir: string,
  openapiFilePath: string,
  tsConfig?: ts.CompilerOptions
}

export async function generate (config: GenerateConfig) {
  const project = new Project({
    compilerOptions: {
      outDir: config.outDir,
      declaration: true,
      ...config.tsConfig
    }
  })
  project.createSourceFile("MyFile.ts", "const num = 1;")
  await project.emit()
}
