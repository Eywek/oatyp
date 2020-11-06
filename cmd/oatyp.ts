#!/usr/bin/env node
// tslint:disable: no-console

import yargs from 'yargs/yargs'
import { generate } from '../src'
import path from 'path'

const argv = yargs(process.argv.slice(2)).options({
  out: { type: 'string', default: '.', alias: ['d', 'destination'] },
  openapiFilePath: { type: 'string', demandOption: true, alias: ['s', 'source'] }
}).argv

generate({
  outDir: path.resolve(process.cwd(), argv.out),
  openapiFilePath: path.resolve(process.cwd(), argv.openapiFilePath)
})
  .then(() => console.log('Done'))
  .catch((err) => {
    console.error('Unable to generate:', err)
    process.exit(1)
  })
