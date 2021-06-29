import type { OpenAPIV3 } from 'openapi-types'

export default class CodeFormatting {
  static camelCase (str: string) {
    const camel = str.replace(/\W+(.)/g, (match, chr) => chr.toUpperCase())
    return camel.charAt(0).toLowerCase() + camel.slice(1)
  }

  static pascalCase (str: string) {
    const camel = CodeFormatting.camelCase(str)
    return camel.charAt(0).toUpperCase() + camel.slice(1)
  }

  static nullable (type: string, nullable: boolean = false) {
    if (nullable === false) {
      return type
    }
    return `${type} | null`
  }

  static extractRef (ref: string) {
    return CodeFormatting.stringifyName(ref.substr('#/components/schemas/'.length))
  }

  static retrieveRef (ref: string, spec: OpenAPIV3.Document): OpenAPIV3.SchemaObject {
    const schema = spec.components!.schemas![ref.substr('#/components/schemas/'.length)]
    if ('$ref' in schema) {
      return CodeFormatting.retrieveRef(schema.$ref, spec)
    }
    return schema
  }

  static stringifyName (name: string) {
    return name.replace(/\.|-/g, '_')
  }

  static removeTagFromMethodName (tag: string, methodName: string) {
    return methodName.replace(new RegExp(tag + '_?', 'gi'), '')
  }
}
