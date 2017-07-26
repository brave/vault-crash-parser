/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const amqp = require('amqplib/callback_api')

// RabbitMQ connection parameters
const MQ_URL = process.env.RABBITMQ_BIGWIG_RX_URL || process.env.AMQP_URL || 'amqp://localhost:5672'

if (!process.env.MQ_VERSION) throw "VERSION environment variable must be set to Muon version"
const MQ_QUEUE = (process.env.MQ_QUEUE || 'crashes') + ':' + process.env.MQ_VERSION

// Connect to messaging system and return a communication channel
export function setup (cb) {
  console.log('Connecting to AMQP server at ' + MQ_URL)
  amqp.connect(MQ_URL, (err, conn) => {
    if (err != null) {
      throw new Error(err)
    }
    console.log('AMQP connection established')
    var on_open = (err, ch) => {
      console.log(`AMQP connected to channel ${MQ_QUEUE}`)
      if (err != null) {
        throw new Error(err)
      }
      // install the queue name on the channel object
      ch.queueName = MQ_QUEUE
      ch.prefetch(1)
      ch.assertQueue(MQ_QUEUE, { durable: true })
      cb(err, ch)
    }
    conn.createChannel(on_open)
  })
}

export function send (msg, ch) {
  console.log(`Message sent to '${MQ_QUEUE}'`)
  ch.sendToQueue(
    MQ_QUEUE,
    Buffer(JSON.stringify(msg)),
    { persistent: true }
  )
}
