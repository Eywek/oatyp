import type { OpenAPIV3 } from 'openapi-types'
import { printNode, ts } from 'ts-morph'
import CodeFormatting from './code-formatting'

interface GenerateTypeContext {
  spec: OpenAPIV3.Document
  prefixRef?: string
  addReadonlyWriteonlyPrefix?: boolean
  opts: GenerateTypeNodeOptions
}

export interface GenerateTypeNodeOptions {
  readonly: boolean
  writeonly: boolean
  addReadonlyAndWriteonlyFilters: boolean
}

// To figure out the proper node types, see https://ts-ast-viewer.com/

export default class CodeGen {
  static generatePickString (params: OpenAPIV3.ParameterObject[]) {
    if (!params || params.length === 0) return '{}'
    return `pick(params, "${params.map((p) => p.name).join('", "')}")`
  }

  static nullableNodeType (node: ts.TypeNode, nullable: boolean): ts.TypeNode {
    if (!nullable) return node
    return ts.factory.createUnionTypeNode([
      node,
      ts.factory.createLiteralTypeNode(ts.factory.createNull())
    ])
  }

  static generatePropertySignature (
    schema: OpenAPIV3.NonArraySchemaObject,
    propName: string | ts.Identifier | ts.StringLiteral,
    propType: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject,
    ctx: GenerateTypeContext,
    isRequired = typeof propName === 'string' && schema.required?.includes(propName) === true
  ) {
    const isReadonly = 'readOnly' in propType && propType.readOnly
    const isWriteonly = 'writeOnly' in propType && propType.writeOnly

    const modifiers = []
    if (isReadonly) {
      modifiers.push(ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword))
    }
    const name = typeof propName === 'string' ? (CodeFormatting.isSafeIdentifier(propName)
      ? ts.factory.createIdentifier(propName)
      : ts.factory.createStringLiteral(propName)) : propName
    const questionToken = isRequired === false
      ? ts.factory.createToken(ts.SyntaxKind.QuestionToken)
      : undefined
    let type: ts.TypeNode | undefined = CodeGen.generateTypeNodeForSchema(propType, ctx)

    if (ctx.opts.readonly === false && isReadonly) {
      return null
    }
    if (ctx.opts.writeonly === false && isWriteonly) {
      return null
    }
    if (ctx.opts.addReadonlyAndWriteonlyFilters) {
      if (isReadonly) {
        type = ts.factory.createIntersectionTypeNode([
          ts.factory.createParenthesizedType(type),
          ts.factory.createTypeReferenceNode(ts.factory.createIdentifier('readonlyP'))
        ])
      } else if (isWriteonly) {
        type = ts.factory.createIntersectionTypeNode([
          ts.factory.createParenthesizedType(type),
          ts.factory.createTypeReferenceNode(ts.factory.createIdentifier('writeonlyP'))
        ])
      }
    }

    return ts.factory.createPropertySignature(
      modifiers,
      name,
      questionToken,
      type
    )
  }

  static generateTypeLiteral (schema: OpenAPIV3.NonArraySchemaObject, ctx: GenerateTypeContext)
  : ts.TypeLiteralNode {
    const propSignatures = (
      Object.entries(schema.properties ?? {})
        .map(([name, prop]) => CodeGen.generatePropertySignature(schema, name, prop, ctx))
        .filter(v => !!v) // remove nulls
    ) as ts.PropertySignature[]
    if (schema.additionalProperties && typeof schema.additionalProperties !== 'boolean') {
      const additionalProperty = CodeGen.generatePropertySignature(schema, ts.factory.createIdentifier('[key: string]'), schema.additionalProperties, ctx, true)
      if (additionalProperty !== null) {
        propSignatures.push(additionalProperty)
      }
    }

    return ts.factory.createTypeLiteralNode(propSignatures)
  }

  // Note: we use another to static to avoid needing to pass every arguments for recursive calls
  static generateTypeNodeForSchema (
    schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject,
    ctx: GenerateTypeContext
  ): ts.TypeNode {
    if ('$ref' in schema) {
      let ref = CodeFormatting.extractRef(schema.$ref)
      if (ctx.prefixRef) ref = `${ctx.prefixRef}${ref}`
      // we don't add prefixes with enums (Types.WithoutReadonly<EnumName> doesn't work)
      const schemaForRef = CodeFormatting.retrieveRef(schema.$ref, ctx.spec)
      const refIsEnum = Array.isArray(schemaForRef.enum)

      if (ctx.addReadonlyWriteonlyPrefix && refIsEnum === false) {
        const typeName = ctx.opts.readonly === true ? 'WithoutWriteonly' : 'WithoutReadonly'
        const typeNameNode = ctx.prefixRef
          // Add namespace prefix if needed
          ? ts.factory.createQualifiedName(
            ts.factory.createIdentifier(ctx.prefixRef),
            ts.factory.createIdentifier(typeName)
          )
          : ts.factory.createIdentifier(typeName)
        return ts.factory.createTypeReferenceNode(
          typeNameNode,
          [ts.factory.createTypeReferenceNode(ts.factory.createIdentifier(ref))]
        )
      }
      return ts.factory.createTypeReferenceNode(ts.factory.createIdentifier(ref))
    }
    if (schema.allOf) {
      const types = schema.allOf.map(s => CodeGen.generateTypeNodeForSchema(s, ctx))
      if (types.length < 2) {
        return CodeGen.nullableNodeType(types[0], !!schema.nullable);
      }
      return ts.factory.createIntersectionTypeNode(types)
    }
    if (schema.oneOf) {
      const types = schema.oneOf.map(s => CodeGen.generateTypeNodeForSchema(s, ctx))
      if (types.length < 2) {
        return CodeGen.nullableNodeType(types[0], !!schema.nullable);
      }
      return ts.factory.createUnionTypeNode(types)
    }

    if (schema.type === 'array') {
      if (!schema.items) {
        return ts.factory.createArrayTypeNode(
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
        )
      }
      return ts.factory.createArrayTypeNode(CodeGen.generateTypeNodeForSchema(schema.items, ctx))
    }

    if (schema.type === 'object') {
      return CodeGen.generateTypeLiteral(schema, ctx)
    }

    if (schema.type === 'boolean') {
      if (schema.enum) {
        return ts.factory.createUnionTypeNode(
          schema.enum.map(name =>
            ts.factory.createTypeReferenceNode(ts.factory.createIdentifier(name))
          )
        )
      }
      return CodeGen.nullableNodeType(
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
        !!schema.nullable
      )
    }

    if (schema.type === 'integer' || schema.type === 'number') {
      if (schema.enum) {
        return  CodeGen.nullableNodeType(ts.factory.createUnionTypeNode(
          schema.enum.map(name =>
            ts.factory.createLiteralTypeNode(ts.factory.createNumericLiteral(name))
          )
        ), !!schema.nullable)
      }
      return CodeGen.nullableNodeType(
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        !!schema.nullable
      )
    }

    if (schema.format === 'date' || schema.format === 'date-time') {
      return CodeGen.nullableNodeType(
        ts.factory.createTypeReferenceNode(ts.factory.createIdentifier('Date')),
        !!schema.nullable
      )
    }

    if (schema.type === 'string') {
      if (schema.enum) {
        const enumNodes = schema.enum.map(name =>
          ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(name))
        )
        return CodeGen.nullableNodeType(enumNodes.length === 1
          ? enumNodes[0]
          : ts.factory.createUnionTypeNode(enumNodes), !!schema.nullable)
      }
      return CodeGen.nullableNodeType(
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        !!schema.nullable
      )
    }

    if (schema.type === 'null') {
      return ts.factory.createLiteralTypeNode(ts.factory.createNull())
    }

    return CodeGen.nullableNodeType(
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      !!schema.nullable
    )
  }

  static generateTypeForSchema (
    schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject,
    spec: OpenAPIV3.Document,
    prefixRef?: string,
    addReadonlyWriteonlyPrefix?: boolean,
    opts: GenerateTypeNodeOptions = {
      readonly: true,
      writeonly: true,
      addReadonlyAndWriteonlyFilters: true
    }
  ) {

    const ctx: GenerateTypeContext = {
      spec,
      prefixRef,
      addReadonlyWriteonlyPrefix,
      opts
    }
    const typeNode = CodeGen.generateTypeNodeForSchema(schema, ctx)
    return printNode(typeNode as ts.Node)
  }
}
