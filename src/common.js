/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
var minidump = require('minidump')
var AWS = require('aws-sdk')
var _ = require('underscore')

const S3_CRASH_BUCKET = process.env.S3_CRASH_BUCKET || 'brave-laptop-crash-reports'
const S3_CRASH_REGION = process.env.S3_CRASH_REGION || 'us-west-2'

if (!process.env.S3_CRASH_KEY || !process.env.S3_CRASH_SECRET) {
  throw new Error('S3_CRASH_KEY and S3_CRASH_SECRET should be set to the S3 account credentials for storing crash reports')
}

// AWS configuration
AWS.config.update({
  accessKeyId: process.env.S3_CRASH_KEY,
  secretAccessKey: process.env.S3_CRASH_SECRET,
  region: S3_CRASH_REGION,
  sslEnabled: true
})

function signature (signatureTokens) {
  var signatureReason = signatureTokens[0][2] || signatureTokens[0][3] || signatureTokens[0][6] || signatureTokens[0][7]
  for (let line of signatureTokens) {
    if (line[2].match(/^(brave|libnode|node)/i)) {
      if (line[3]) {
        return line[3]
      }
    }
  }
  return signatureReason
}

exports.metadataFromMachineCrash = (crash) => {
  var lines = crash.split(/\n/)
  var osTokens = lines[0].split('|')
  var cpuTokens = lines[1].split('|')
  var crashTokens = lines[2].split('|')

  var sig = 'unknown'
  if (crashTokens[3]) {
    var threadLines = (lines.filter((line) => {
      return line.match(new RegExp("^" + crashTokens[3]))
    }) || []).map((line) => {
      return line.split('|')
    })
    sig = signature(threadLines)
  } else {
    console.log('Warning: no crash thread number given - signature unknown')
  }

  var operating_system_name = null
  if (osTokens[1] === 'win32') {
    operating_system_name = matchWindowsOperatingSystem(osTokens[2])
  } else {
    operating_system_name = osTokens[2]
  }

  return {
    signature: sig,
    operating_system: osTokens[1],
    operating_system_version: osTokens[2],
    operating_system_name: operating_system_name,
    cpu: cpuTokens[1],
    cpu_family: cpuTokens[2],
    cpu_count: cpuTokens[3],
    crash_reason: crashTokens[1],
    crash_address: crashTokens[2],
    crash_thread: crashTokens[3]
  }
}

// Unfortunately we have to walk the stack twice
// to parse a crash report - once to retrieve the
// symbol substituted plain text and once to
// retrieve the metadata
exports.parseCrashHandler = (filename, cb) => {
  const symbolPaths = require('electron-debug-symbols').paths()

  const readPlainText = (plainTextCallback) => {
    minidump.walkStack(filename, symbolPaths, (err, results) => {
      if (err) {
        console.log('Warning: problem retrieving human readable version. This is often caused by a missing threads section.')
      }
      results = results || ''
      plainTextCallback(err, results.toString())
    }, { machine: false })
  }

  const readMetadata = (metadataCallback) => {
    minidump.walkStack(filename, symbolPaths, (err, results) => {
      if (err) {
        console.log('Warning: problem retrieving machine readable version. This is often caused by a missing threads section.')
      }
      results = results || ''
      var metadata = {}
      if (results) {
        metadata = exports.metadataFromMachineCrash(results.toString())
      }
      metadataCallback(err, metadata)
    }, { machine: true })
  }

  readPlainText((plainTextErr, plainText) => {
    readMetadata((metadataErr, metadata) => {
      // We are not passing the errors to the calling function as they are being warned above
      console.log(plainText)
      cb(null, plainText, metadata)
    })
  })
}

// Retrieve a binary minidump file from S3, parse it, and
// substitute symbols
exports.readAndParse = (id, cb) => {
  var s3 = new AWS.S3()
  var params = {
    Bucket: S3_CRASH_BUCKET,
    Key: id
  }
  var filename = '/tmp/' + id
  var file = require('fs').createWriteStream(filename)

  console.log('Reading dump file from bucket ' + S3_CRASH_BUCKET + ' with id ' + id)

  s3.getObject(params).
    on('httpData', function(chunk) { file.write(chunk) }).
    on('httpDone', function() {
      exports.parseCrashHandler(filename, cb)
    }).
    on('error', function(err) {
      console.log("Error retrieving crash report from S3")
      throw new Error(err)
      cb(err)
    }).
    send()
}

// Write symbolized crash report to the S3 crash bucket
exports.writeParsedCrashToS3 = (id, symbolizedCrashReport, cb) => {
  var k = `${id}.symbolized.txt`
  console.log(`[${id}] symbolized crash report writing to ${S3_CRASH_BUCKET} as ${k} with length ${symbolizedCrashReport.length}`)
  if (symbolizedCrashReport.length === 0) {
    console.log(`[${id}] contains an invalid crash report - storing 'Invalid crash report'`)
    symbolizedCrashReport = "Invalid crash report"
  }
  var s3obj = new AWS.S3({
    params: {
      Bucket: S3_CRASH_BUCKET,
      Key: k
    }
  })
  s3obj.upload( { Body: symbolizedCrashReport } ).send(cb)
}

// Retrieve a binary minidump file from S3
exports.readAndStore = (id, cb) => {
  var s3 = new AWS.S3()
  var params = {
    Bucket: S3_CRASH_BUCKET,
    Key: id
  }
  var filename = '/tmp/' + id
  var file = require('fs').createWriteStream(filename)

  console.log('Reading dump file from bucket ' + S3_CRASH_BUCKET + ' with id ' + id)

  s3.getObject(params).
    on('httpData', function(chunk) { file.write(chunk) }).
    on('httpDone', function() { cb(filename) }).
    on('error', function(err) {
      console.log("Error retrieving crash report from S3")
      throw new Error(err)
      cb(err)
    }).
    send()
}

export function readSymbolized (id, cb) {
  var s3 = new AWS.S3()
  var params = {
    Bucket: S3_CRASH_BUCKET,
    Key: id + '.symbolized.txt'
  }
  var done = function(err, data) {
    var crashReport = ""
    if (err) {
      crashReport = 'Unavailable'
    } else {
      crashReport = data.Body.toString()
    }
    cb(null, crashReport)
  }
  s3.getObject(params, done)
}

const windowsVersionMatchers = [
  ['5.0', 'Windows 2000'],
  ['5.1', 'Windows XP'],
  ['5.2', 'Windows Server 2003 or Windows XP'],
  ['6.0', 'Windows Vista'],
  ['6.1', 'Windows 7'],
  ['6.2', 'Windows 8'],
  ['6.3', 'Windows 8.1'],
  ['10', 'Windows 10']
]

// Match a Windows operating system version to a label
export function matchWindowsOperatingSystem (os) {
  var matches = windowsVersionMatchers.filter((matcher) => {
    return os.match(new RegExp(`^${matcher[0]}`))
  })
  if (matches.length) {
    return matches[0][1]
  } else {
    return 'unknown'
  }
}
