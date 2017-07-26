/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const async = require('async')

// resources
const pgc = require('./pgc')
const amqpc = require('./amqpc')

const common = require('./common')

// This is triggered when connections to all resources are established
const resourcesReady = function (asyncError, resources) {
  if (asyncError) {
    throw new Error(asyncError.toString())
  }

  // Write crash report meta data to Postgres
  const writeToPostgres = function (id, contents, cb) {
    resources.pg.query(
      'INSERT INTO dtl.crashes (id, contents) VALUES($1, $2) ON CONFLICT (id) DO UPDATE SET contents = $2',
      [id, JSON.stringify(contents)],
      cb
    )
  }

  // Build a function capable of retrieving the crash report,
  // parsing and writing it to Postgres and ES
  function buildMessageHandler (msg, msgContents) {
    return function (cb) {
      console.log(`[${msgContents._id}] parsing crash report`)
      // Read crash report from S3 and parse with minidump
      // (which handles Symbol substitution)
      common.readAndParse(msgContents._id, (miniError, crashReport, metadata) => {
        crashReport = crashReport.toString()

        // install the parser minidump metadata into the crash report
        msgContents.metadata = metadata

        // Fill in missing info for crashes that come in without version / platform info (macOS generally)
        if (!msgContents._version) {
          msgContents._version = '0.0.0'
        }
        if (!msgContents.platform) {
          if (msgContents.metadata.operating_system.match(/^Mac/)) {
            msgContents.platform = 'darwin'
          } else {
            msgContents.platform = 'unknown'
          }
        }

        // Write the record to Postgres
        writeToPostgres(
          msgContents._id,
          msgContents,
          function(pgErr, results) {
            if (pgErr) {
              console.log(pgErr.toString())
            }
            console.log(`[${msgContents._id}] written to Postgres`)

            // done, ack the message and callback
            common.writeParsedCrashToS3(msgContents._id, crashReport, function (s3WriteError) {
              if (s3WriteError) {
                console.log(s3WriteError)
              }
              resources.ch.ack(msg)
              cb(null)
            })
          }
        ) 

      })
    }
  }

  // Start listening for messages
  console.log('All resources available.')
  console.log('Reading messages from AMQP')

  // Read messages from queue
  resources.ch.consume(resources.ch.queueName, (msg) => {
    var msgContents = JSON.parse(msg.content.toString())
    console.log(`[${msgContents._id}] ******************** start ********************`)
    var handler = buildMessageHandler(msg, msgContents)
    handler(function(err) {
      console.log(`[${msgContents._id}] complete`)
    })
  })
}

// Startup, connect to all required resources and start processing
async.parallel({
  pg: pgc.setup,
  ch: amqpc.setup
}, resourcesReady)
