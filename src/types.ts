import { CodeBlockWriter, SourceFile, WriterFunction, WriterFunctionOrValue, Writers } from 'ts-morph'
import { OpenAPIV3 } from 'openapi-types'

type WriterFunctionOrString = string | WriterFunction

export async function generateTypes (
  file: SourceFile,
  spec: OpenAPIV3.Document
): Promise<void> {
  // Idea from https://stackoverflow.com/a/52443757
  file.addTypeAlias({
    name: 'readonlyP',
    type: '{ readonly?: undefined }'
  })
  file.addTypeAlias({
    name: 'writeonlyP',
    type: '{ writeonly?: undefined }'
  })

  file.addTypeAlias({
    name: 'Primitive',
    type: 'string | Function | number | boolean | Symbol | undefined | null | Date'
  })
  for (const modifier of ['Readonly', 'Writeonly']) {
    file.addTypeAlias({
      name: `No${modifier}Keys`,
      typeParameters: ['T'],
      type: (writer) => {
        writer.writeLine('NonNullable<{')
        writer.withIndentationLevel(1, () => writer.writeLine(`[P in keyof T]: '${modifier.toLowerCase()}' extends keyof T[P] ? never : P`))
        writer.writeLine('}[keyof T]>')
      }
    })
    file.addTypeAlias({
      name: `Without${modifier}`,
      typeParameters: ['T'],
      isExported: true,
      type: (writer) => {
        writer.newLine()
        writer.withIndentationLevel(1, () => writer.writeLine('T extends Primitive ? T :'))
        writer.withIndentationLevel(1, () => writer.writeLine(`T extends Array<infer U> ? Without${modifier}<U>[] :`))
        writer.withIndentationLevel(1, () => writer.writeLine('{'))
        writer.withIndentationLevel(2, () => writer.writeLine(`[key in No${modifier}Keys<T>]: T[key] extends infer TP ? Without${modifier}<TP> :`))
        writer.withIndentationLevel(3, () => writer.writeLine(`never`))
        writer.withIndentationLevel(1, () => writer.writeLine('}'))
      }
    })
  }

  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    if ('enum' in schema && schema.enum) {
      file.addEnum({
        isExported: true,
        name,
        members: schema.enum.map((val) => ({ name: val.toUpperCase(), value: val }))
      })
      continue
    }
    file.addTypeAlias({
      isExported: true,
      name: stringifyName(name),
      type: generateTypeForSchema(schema)
    })
  }
}

export function generateTypeForSchema (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject,
  prefixRef?: string,
  suffixRef?: string
): WriterFunctionOrString {
  // Note: we use another to function to avoid needing to pass every arguments for recursive calls
  function generate (
    schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject
  ): WriterFunctionOrString {
    if ('$ref' in schema) {
      let ref = extractRef(schema.$ref)
      if (prefixRef) ref = `${prefixRef}${ref}`
      if (suffixRef) ref += suffixRef
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
          props[`'${name}'${questionMark}`] = (writer) => {
            writeWriterOrString(writer, generate(prop))
            if ('readOnly' in prop && prop.readOnly) {
              writer.write(' & readonlyP')
            }
            if ('writeOnly' in prop && prop.writeOnly) {
              writer.write(' & writeonlyP')
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

function stringifyName (name: string) {
  return name.replace(/\.|-/g, '_')
}
