<div align="center">

  <h1>oatyp</h1>
  <h2> <b>O</b>pen<b>A</b>PI <b>Typ</b>escript Generator</h2>

  This tools is inspired from [openapi-generator](https://github.com/OpenAPITools/openapi-generator), the purpose is to be able to generate Typescript typings from openapi definitions

  We're using [ts-morph](https://github.com/dsherret/ts-morph) and [axios](https://github.com/axios/axios) under the hood.

  [![codecov](https://codecov.io/gh/Eywek/oatyp/branch/main/graph/badge.svg?token=8hLCf5qoDU)](https://codecov.io/gh/Eywek/oatyp)
</div>

## Why

Openapi generator is a great tool and it's working fine for simple typescript typings, which I think are the principal use case, It's used by many developers and It's maintained.

**BUT**, this tool is handling dozen of languages, generating client and server codes via OpenAPI, so obviously some generators are broken or have some annoying bugs ([openapi-generator#6332](https://github.com/OpenAPITools/openapi-generator/issues/6332), [openapi-generator#7886](https://github.com/OpenAPITools/openapi-generator/issues/7886), [openapi-generator#4190](https://github.com/OpenAPITools/openapi-generator/issues/4190), [openapi-generator#7887](https://github.com/OpenAPITools/openapi-generator/issues/7887)). Some of this bugs are preventing us from using the tool. 

I'm not really familiar with Java, and I really need something that works well with Typescript quickly. That's why I've created this package, the ambition is not to support multiple language, supporting Typescript seems fine. And generating code with [ts-morph](https://github.com/dsherret/ts-morph) is something pretty easy.

## Features

- Generate typings for each operation's body and response
- Generate class and methods for each operation, scoped by tags, named after operationId
- Exposing axios client
- Handling readonly and writeonly properties
- Removing prefixes from operationId (`role-create` → `create`, which give `Role.create` if tag is `Role`)
