import type { OpenAPIV3 } from 'openapi-types'
import { WriterFunctionOrValue, Writers } from 'ts-morph'
import { writeWriterOrString } from './writer-utils'
import CodeFormatting from './code-formatting'
import type { WriterFunctionOrString } from './writer-utils'

export default class CodeGen {
  static generatePickString (params: OpenAPIV3.ParameterObject[]) {
    if (!params || params.length === 0) return '{}'
    return `pick(params, "${params.map((p) => p.name).join('", "')}")`
  }

  static generateTypeForSchema (
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
        let ref = CodeFormatting.extractRef(schema.$ref)
        if (prefixRef) ref = `${prefixRef}${ref}`
        // we don't add prefixes with enums (Types.WithoutReadonly<EnumName> doesn't work)
        const schemaForRef = CodeFormatting.retrieveRef(schema.$ref, spec)
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
        if (types.length < 2) {
          return types[0]
        }
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
        return CodeFormatting.nullable('boolean', schema.nullable)
      }
      if (schema.type === 'integer' || schema.type === 'number') {
        if (schema.enum) {
          return schema.enum.join(' | ')
        }
        return CodeFormatting.nullable('number', schema.nullable)
      }
      if (schema.format === 'date' || schema.format === 'date-time') {
        return CodeFormatting.nullable('Date', schema.nullable)
      }
      if (schema.type === 'string') {
        if (schema.enum) {
          return schema.enum.map(member => `'${member}'`).join(' | ')
        }
        return CodeFormatting.nullable('string', schema.nullable)
      }
      return CodeFormatting.nullable('any', schema.nullable)
    }
    return generate(schema)
  }
}
