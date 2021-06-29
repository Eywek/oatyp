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
    // Idea from https://stackoverflow.com/a/52443757
    file.addTypeAlias({
      name: 'readonlyP',
      type: "{ readonly?: '__readonly' }"
    })
    file.addTypeAlias({
      name: 'writeonlyP',
      type: "{ writeonly?: '__writeonly' }"
    })
    // Hack to display computed types instead of Pick<...>
    // From https://github.com/microsoft/vscode/issues/94679#issuecomment-611320155
    file.addTypeAlias({
      name: 'Id',
      typeParameters: ['T'],
      type: '{} & { [P in keyof T]: T[P] }'
    })

    file.addTypeAlias({
      name: 'Primitive',
      type: 'string | Function | number | boolean | Symbol | undefined | null | Date'
    })
    // From: https://stackoverflow.com/a/63448246
    file.addTypeAlias({
      name: 'Without',
      typeParameters: ['T', 'V', {
        name: 'WithNevers',
        default: (writer) => {
          writer.writeLine('{')
          writer.withIndentationLevel(1, () => writer.writeLine('[K in keyof T]: Exclude<T[K], undefined> extends V ? never'))
          writer.withIndentationLevel(1, () => writer.writeLine(': (T[K] extends Record<string, unknown> ? Without<T[K], V> : T[K])'))
          writer.write('}')
        }
      }],
      type: (writer) => {
        writer.writeLine('Id<Pick<WithNevers, {')
        writer.withIndentationLevel(1, () => writer.writeLine('[K in keyof WithNevers]: WithNevers[K] extends never ? never : K'))
        writer.writeLine('}[keyof WithNevers]>>')
      }
    })
    for (const modifier of ['Readonly', 'Writeonly']) {
      file.addTypeAlias({
        name: `Remove${modifier}`,
        typeParameters: ['T'],
        type: (writer) => {
          writer.newLine()
          writer.withIndentationLevel(1, () => writer.writeLine('T extends Primitive ? T :'))
          writer.withIndentationLevel(1, () => writer.writeLine(`T extends Array<infer U> ? Remove${modifier}<U>[] :`))
          writer.withIndentationLevel(1, () => writer.writeLine('{'))
          writer.withIndentationLevel(2, () => writer.writeLine(`[key in keyof T]: '${modifier.toLowerCase()}' extends keyof T[key] ?`))
          // we also need to check the value to avoid matching Record<string, any>
          writer.withIndentationLevel(4, () => writer.writeLine(`T[key]['${modifier.toLowerCase()}'] extends '__${modifier.toLowerCase()}' | undefined ? never : Remove${modifier}<T[key]> :`))
          writer.withIndentationLevel(3, () => writer.writeLine(`T[key] extends infer TP ? Remove${modifier}<TP> :`))
          writer.withIndentationLevel(3, () => writer.writeLine(`never`))
          writer.withIndentationLevel(1, () => writer.writeLine('}'))
        }
      })
      file.addTypeAlias({
        name: `Without${modifier}`,
        typeParameters: ['T'],
        isExported: true,
        type: `Without<Remove${modifier}<T>, never>`
      })
    }
  }

  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    if ('enum' in schema && schema.enum) {
      if (typeof schema.enum[0] === 'number') {
        file.addTypeAlias({
          isExported: true,
          name,
          type: schema.enum.length > 1 ?
            Writers.unionType(...(schema.enum.map(m => String(m)) as [string, string, ...string[]])) :
            String(schema.enum[0])
        })
      } else {
        file.addEnum({
          isExported: true,
          name,
          members: schema.enum.map((val) => ({ name: val.toUpperCase(), value: val }))
        })
      }
      continue
    }
    file.addTypeAlias({
      isExported: true,
      name: CodeFormatting.stringifyName(name),
      type: CodeGen.generateTypeForSchema(schema, spec)
    })
  }
}
