import { CodeBlockWriter, SourceFile, WriterFunction, WriterFunctionOrValue, Writers } from 'ts-morph'
import { OpenAPIV3 } from 'openapi-types'

type WriterFunctionOrString = string | WriterFunction

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
      name: stringifyName(name),
      type: generateTypeForSchema(schema, spec)
    })
  }
}

export function generateTypeForSchema (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject,
  spec: OpenAPIV3.Document,
  prefixRef?: string,
  addReadonlyWriteonlyPrefix?: boolean,
  opts: { readonly: boolean, writeonly: boolean, addReaonlyAndWriteonlyFilters: boolean } = {
    readonly: true,
    writeonly: true,
    addReaonlyAndWriteonlyFilters: true
  }
): WriterFunctionOrString {
  // Note: we use another to function to avoid needing to pass every arguments for recursive calls
  function generate (
    schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject
  ): WriterFunctionOrString {
    if ('$ref' in schema) {
      let ref = extractRef(schema.$ref)
      if (prefixRef) ref = `${prefixRef}${ref}`
      // we don't add prefixes with enums (Types.WithoutReadonly<EnumName> doesn't work)
      const schemaForRef = retrieveRef(schema.$ref, spec)
      const refIsEnum = Array.isArray(schemaForRef.enum)
      if (addReadonlyWriteonlyPrefix && refIsEnum === false) {
        const typeName = opts.readonly === true ? 'WithoutWriteonly' : 'WithoutReadonly'
        ref = `${prefixRef ?? ''}${typeName}<${ref}>`
      }
      return ref
    }
    if (schema.allOf) {
      const types: WriterFunctionOrString[] = schema.allOf.map((subschema) => {
        return generate(subschema)
      })
      if (types.length < 2) {
        return types[0]
      }
      return Writers.intersectionType(...(types as [WriterFunctionOrString, WriterFunctionOrString, ...WriterFunctionOrString[]]))
    }
    if (schema.oneOf) {
      const types = schema.oneOf.map((subschema) => {
        return generate(subschema)
      }) as [WriterFunctionOrString, WriterFunctionOrString, ...WriterFunctionOrString[]]
      return Writers.unionType(...types)
    }
    if (schema.type === 'array') {
      const writerOrValue = generate(schema.items)
      return (writer) => {
        writer.write('(')
        if (typeof writerOrValue === 'function') {
          writerOrValue(writer)
        } else {
          writer.write(writerOrValue)
        }
        writer.write(')[]')
      }
    }
    if (schema.type === 'object') {
      const props = Object.entries(schema.properties ?? {})
        .reduce((props, [name, prop]) => {
          const questionMark = schema.required?.includes(name) === true ? '' : '?'
          const isReadonly = 'readOnly' in prop && prop.readOnly
          const isWriteonly = 'writeOnly' in prop && prop.writeOnly
          if (opts.readonly === false && isReadonly) {
            return props
          }
          if (opts.writeonly === false && isWriteonly) {
            return props
          }
          props[`${isReadonly ? 'readonly ' : ''}'${name}'${questionMark}`] = (writer) => {
            if (opts.addReaonlyAndWriteonlyFilters && (isReadonly || isWriteonly)) {
              writer.write('(') // we need to surround with parenthesis for unions (e.g. (string | number) & readOnly)
            }
            writeWriterOrString(writer, generate(prop))
            if (opts.addReaonlyAndWriteonlyFilters && isReadonly) {
              writer.write(') & readonlyP') // Used to remove them with mapped types
            }
            if (opts.addReaonlyAndWriteonlyFilters && isWriteonly) {
              writer.write(') & writeonlyP') // Used to remove them with mapped types
            }
          }
          return props
        }, {} as Record<string, WriterFunctionOrValue>)
      if (schema.additionalProperties && typeof schema.additionalProperties !== 'boolean') {
        props[`[key: string]`] = generate(schema.additionalProperties)
      }
      return Writers.object(props)
    }
    if (schema.type === 'boolean') {
      if (schema.enum) {
        return schema.enum.join(' | ')
      }
      return 'boolean'
    }
    if (schema.type === 'integer' || schema.type === 'number') {
      if (schema.enum) {
        return schema.enum.join(' | ')
      }
      return 'number'
    }
    if (schema.format === 'date' || schema.format === 'date-time') {
      return 'Date'
    }
    if (schema.type === 'string') {
      if (schema.enum) {
        return schema.enum.map(member => `'${member}'`).join(' | ')
      }
      return 'string'
    }
    return 'any'
  }
  return generate(schema)
}

export function writeWriterOrString (
  writer: CodeBlockWriter,
  writerOrValue: WriterFunctionOrString
) {
  if (typeof writerOrValue === 'function') {
    writerOrValue(writer)
  } else {
    writer.write(writerOrValue)
  }
}

function extractRef (ref: string) {
  return stringifyName(ref.substr('#/components/schemas/'.length))
}

function retrieveRef (ref: string, spec: OpenAPIV3.Document): OpenAPIV3.SchemaObject {
  const schema = spec.components!.schemas![ref.substr('#/components/schemas/'.length)]
  if ('$ref' in schema) {
    return retrieveRef(schema.$ref, spec)
  }
  return schema
}

function stringifyName (name: string) {
  return name.replace(/\.|-/g, '_')
}
