import type { WriterFunction, CodeBlockWriter } from 'ts-morph'

export type WriterFunctionOrString = string | WriterFunction

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
