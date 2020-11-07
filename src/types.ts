import { SourceFile, WriterFunction, WriterFunctionOrValue, Writers } from 'ts-morph'
import { OpenAPIV3 } from 'openapi-types'

type WriterFunctionOrString = string | WriterFunction

export async function generateTypes (
  file: SourceFile,
  spec: OpenAPIV3.Document
): Promise<void> {
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

function generateTypeForSchema (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject
): WriterFunctionOrString {
  if ('$ref' in schema) {
    return extractRef(schema.$ref)
  }
  if (schema.allOf) {
    const types: WriterFunctionOrString[] = schema.allOf.map((subschema) => {
      return generateTypeForSchema(subschema)
    })
    if (types.length < 2) {
      return types[0]
    }
    return Writers.intersectionType(...(types as [WriterFunctionOrString, WriterFunctionOrString, ...WriterFunctionOrString[]]))
  }
  if (schema.oneOf) {
    const types = schema.oneOf.map((subschema) => {
      return generateTypeForSchema(subschema)
    }) as [WriterFunctionOrString, WriterFunctionOrString, ...WriterFunctionOrString[]]
    return Writers.unionType(...types)
  }
  if (schema.type === 'array') {
    const writerOrValue = generateTypeForSchema(schema.items)
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
        const questionMark = schema.required?.includes(name) === false ? '?' : ''
        props[`'${name}'${questionMark}`] = generateTypeForSchema(prop)
        return props
      }, {} as Record<string, WriterFunctionOrValue>)
    if (schema.additionalProperties && typeof schema.additionalProperties !== 'boolean') {
      props[`[key: string]`] = generateTypeForSchema(schema.additionalProperties)
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

function extractRef (ref: string) {
  return stringifyName(ref.substr('#/components/schemas/'.length))
}

function stringifyName (name: string) {
  return name.replace(/\.|-/g, '_')
}
