import { SourceFile, Writers } from 'ts-morph'
import CodeFormatting from './code-formatting'
import CodeGen from './code-gen'
import type { OpenAPIV3 } from 'openapi-types'

export async function generateTypes (
  file: SourceFile,
  spec: OpenAPIV3.Document,
  opts: { addReadonlyWriteonlyModifiers: boolean }
): Promise<void> {
  if (opts.addReadonlyWriteonlyModifiers === true) {
    addReadonlyWriteonlyModifiers(file)
  }

  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    if ('enum' in schema && schema.enum) {
      if (typeof schema.enum[0] === 'number') {
        file.addTypeAlias({
          isExported: true,
          name: CodeFormatting.makeNameSafeForIdentifier(name),
          type: schema.enum.length > 1 ?
            Writers.unionType(...(schema.enum.map(m => String(m)) as [string, string, ...string[]])) :
            String(schema.enum[0])
        })
      } else {
        file.addEnum({
          isExported: true,
          name: CodeFormatting.makeNameSafeForIdentifier(name),
          members: schema.enum.map((val) => ({ name: val.toUpperCase(), value: val }))
        })
      }
      continue
    }
    file.addTypeAlias({
      isExported: true,
      name: CodeFormatting.makeNameSafeForIdentifier(name),
      type: CodeGen.generateTypeForSchema(schema, spec)
    })
  }
}

function addReadonlyWriteonlyModifiers (file: SourceFile) {
  // Idea from https://stackoverflow.com/a/52443757
  file.addTypeAlias({
    name: 'readonlyP',
    type: "{ readonly?: '__readonly' }"
  })
  file.addTypeAlias({
    name: 'writeonlyP',
    type: "{ writeonly?: '__writeonly' }"
  })

  file.addTypeAlias({
    name: 'Primitive',
    type: 'string | Function | number | boolean | Symbol | undefined | null | Date'
  })
  for (const modifier of ['Readonly', 'Writeonly']) {
    file.addTypeAlias({
      name: `PropsWithout${modifier}`,
      typeParameters: ['T'],
      type: (writer) => {
        writer.write('{')
        // we also need to check the value to avoid matching Record<string, any>
        writer.withIndentationLevel(1, () => writer.writeLine(`[key in keyof T]: T[key] extends ${modifier.toLowerCase()}P`))
        writer.withIndentationLevel(2, () => writer.writeLine(`? NonNullable<T[key]['${modifier.toLowerCase()}']> extends '__${modifier.toLowerCase()}' ? never : key`))
        writer.withIndentationLevel(2, () => writer.writeLine(`: key`))
        writer.write('}[keyof T]')
      }
    })
    file.addTypeAlias({
      name: `Without${modifier}`,
      typeParameters: ['T'],
      isExported: true,
      type: (writer) => {
        writer.write('T extends any ?')
        writer.withIndentationLevel(1, () => writer.writeLine('T extends Primitive ? T :'))
        writer.withIndentationLevel(1, () => writer.writeLine(`T extends Array<infer U> ? Without${modifier}<U>[] :`))
        writer.withIndentationLevel(1, () => writer.writeLine('keyof T extends never ? unknown :')) // handle unknown values
        writer.withIndentationLevel(1, () => writer.writeLine('{'))
        // note: we use Pick<> instead of `key in PropsWithout${modifier}<T>` to keep `?` modifier
        writer.withIndentationLevel(2, () => writer.writeLine(`[key in keyof Pick<T, PropsWithout${modifier}<T>>]: Pick<T, PropsWithout${modifier}<T>>[key] extends any`))
        writer.withIndentationLevel(3, () => writer.writeLine(`? Without${modifier}<Pick<T, PropsWithout${modifier}<T>>[key]>`))
        writer.withIndentationLevel(3, () => writer.writeLine(`: never`))
        writer.withIndentationLevel(1, () => writer.write('}'))
        writer.write(': never')
      }
    })
  }
}
