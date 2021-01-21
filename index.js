'use strict'

const notFoundRegex = /notfound/i
const ltgtKeys = ['lt', 'gt', 'lte', 'gte', 'start', 'end']

class EncodingError extends Error {
  constructor (cause, prefix) {
    super(prefix + cause.message)

    this.name = 'EncodingError'
    this.type = 'async-level.encoding'
    this.causeErr = cause
    this.status = 404
  }

  cause () {
    return this.causeErr
  }
}

class NotFoundError extends Error {
  constructor (message) {
    super(message)

    this.name = 'NotFoundError'
    this.type = 'async-level.not-found'
    this.notFound = true
  }
}

class Result {
  constructor (err, data) {
    this.err = err
    this.data = data
  }
}

class BatchOp {
  constructor (type, key, value) {
    this.type = type
    this.key = key
    this.value = value
  }
}

class IteratorResult {
  constructor (done, value) {
    this.done = done
    this.value = value
  }
}

class KVPair {
  constructor (key, value) {
    this.key = key
    this.value = value
  }
}

class MultiKVPair {
  constructor (keys, values) {
    this.keys = keys
    this.values = values
  }
}

/**
 * Small wrapper that adds Promise<{ err, data }> support
 * for leveldown
 */
class AsyncLevelDown {
  constructor (db, options = {}) {
    assert(db, 'db required')
    this.leveldown = db

    // Function to encode values
    this.encode = options.encode || identity
    // Function to decode values
    this.decode = options.decode || identity
    // Function to encode keys
    this.keyEncode = options.keyEncode || identity

    if (options.keyEncoding) {
      throw new Error('options.keyEncoding not supported')
    }
    if (options.valueEncoding && options.valueEncoding !== 'json') {
      throw new Error('only valueEncoding: "json" is supported')
    }

    if (options.valueEncoding === 'JSON') {
      this.encode = JSON.stringify
      this.decode = JSON.parse
    }

    this._isOpen = false
    this._pendingEnsure = null
  }

  async ensure () {
    assert(!this.closed, 'cannot ensure() after close()')
    if (this._isOpen) return
    if (this._pendingEnsure) return this._pendingEnsure

    this._pendingEnsure = this._ensure()
    const { err } = await this._pendingEnsure
    this._pendingEnsure = null

    /**
     * In this case just throw the error since no-one handles
     * this error properly. If we do not throw we would have
     * to check in effectively every method.
     */
    if (err) {
      throw err
    }
  }

  async _ensure () {
    assert(!this.closed, 'cannot _ensure() after close()')
    const { err } = await this.open()
    if (err) {
      this.leveldown = null
      return { err }
    }

    this._isOpen = true
    return {}
  }

  open () {
    assert(!this.closed, 'cannot open() after close()')
    return new Promise((resolve) => {
      assert(!this.closed, 'cannot open() after close()')
      this.leveldown.open((err) => {
        resolve(new Result(err, null))
      })
    })
  }

  clear (options) {
    assert(!this.closed, 'cannot clear() after close()')
    const copyOpts = {}
    for (const k of Object.keys(options)) {
      copyOpts[k] = ltgtKeys.includes(k)
        ? this.keyEncode(options[k]) : options[k]
    }

    return new Promise((resolve) => {
      assert(!this.closed, 'cannot clear() after close()')
      this.leveldown.clear(copyOpts, (err) => {
        resolve(new Result(err, null))
      })
    })
  }

  close () {
    assert(!this.closed, 'cannot close() after close()')
    this.closed = true
    return new Promise((resolve) => {
      this.leveldown.close((err) => {
        resolve(new Result(err, null))
      })
    })
  }

  put (key, value, options) {
    assert(!this.closed, 'cannot put() after close()')
    const encodedKey = this.keyEncode(key)

    return new Promise((resolve) => {
      let rawValue
      try {
        rawValue = this.encode(value)
      } catch (err) {
        const encErr = new EncodingError(err, 'encode in put(): ')
        return resolve(new Result(encErr, null))
      }

      assert(!this.closed, 'cannot put() after close()')
      this.leveldown.put(
        encodedKey, rawValue, options || null,
        (err) => {
          resolve(new Result(err, null))
        }
      )
    })
  }

  get (key, options) {
    assert(!this.closed, 'cannot get() after close()')
    const encodedKey = this.keyEncode(key)
    return new Promise((resolve) => {
      assert(!this.closed, 'cannot get() after close()')
      this.leveldown.get(
        encodedKey, options || null,
        (err, value) => {
          if (err) {
            if (notFoundRegex.test(err.message)) {
              const notFoundErr = new NotFoundError(
                'Key not found in database [' + key + ']'
              )
              return resolve(new Result(notFoundErr, null))
            }

            return resolve(new Result(err, null))
          }

          let decoded
          try {
            decoded = this.decode(value)
          } catch (err) {
            const encErr = new EncodingError(err, 'decode in get(): ')
            resolve(new Result(encErr, null))
          }

          resolve(new Result(null, decoded))
        }
      )
    })
  }

  del (key, options) {
    assert(!this.closed, 'cannot del() after close()')
    const encodedKey = this.keyEncode(key)
    return new Promise((resolve) => {
      assert(!this.closed, 'cannot del() after close()')
      this.leveldown.del(encodedKey, options || null, (err) => {
        resolve(new Result(err, null))
      })
    })
  }

  iterator (options) {
    assert(!this.closed, 'cannot iterator() after close()')
    const copyOpts = {}
    for (const k of Object.keys(options)) {
      copyOpts[k] = ltgtKeys.includes(k)
        ? this.keyEncode(options[k]) : options[k]
    }

    const rawItr = this.leveldown.iterator(copyOpts)
    return new LevelAsyncIterator(rawItr, this.decode, this)
  }

  batch (operations, options) {
    assert(!this.closed, 'cannot batch() after close()')
    return new Promise((resolve) => {
      const rawOperations = new Array(operations.length)
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i]
        let encodedValue
        try {
          encodedValue = this.encode(op.value)
        } catch (err) {
          const encErr = new EncodingError(err, 'encode in batch(): ')
          return resolve(new Result(encErr, null))
        }

        const encodedKey = this.keyEncode(op.key)
        rawOperations[i] = new BatchOp(
          op.type, encodedKey, encodedValue
        )
      }

      assert(!this.closed, 'cannot batch() after close()')
      this.leveldown.batch(
        rawOperations, options || null, (err) => {
          resolve(new Result(err, null))
        }
      )
    })
  }
}

/**
 * The underlying implementation of `leveldown` has a "feature"
 *    where the first call to `next()` ignores the HighWatermark
 *    and the `iterator.cache` functionality.
 *
 * This variable `landed` get's reset every time you call
 *    seek() on the iterator. It's meant to allow you
 *    to read only one value at a time when calling `seek()`
 *    instead of filling up the higherwatermark.
 *
 * For our use case when not doing seeking and just reading
 *    all values for a given range query we want to basically
 *    do two calls to `next()` in `batchNext()` for the very
 *    first time so that we can batch read upto the
 *    `HighWaterMark` or upto 1000 key/value pairs.
 */
class LevelAsyncIterator {
  constructor (levelDownItr, decode, asyncLevel) {
    assert(asyncLevel, 'asyncLevel required')
    this._iterator = levelDownItr
    this._landed = false
    this.asyncLevel = asyncLevel

    this.decode = decode
    this.finished = false
    this.pendingNext = false
  }

  /**
   * TODO: Support parallel iteration.
   * This class has a lot of simplification in it based on the
   * assumption that the consumer will only call `next()`
   * sequentially.
   *
   * See https://github.com/nodejs/node/blob/master/lib/internal/streams/async_iterator.js
   */
  next () {
    assert(!this.asyncLevel.closed, 'cannot next() after close()')
    if (this.pendingNext) {
      throw new Error(
        'It is not safe to call Iterator.next() concurrently'
      )
    }
    this.pendingNext = true
    return new Promise((resolve) => {
      if (this.finished) {
        this.pendingNext = false
        return resolve(new IteratorResult(true, null))
      }

      assert(!this.asyncLevel.closed, 'cannot next() after close()')
      this._iterator.next((err, key, value) => {
        this.pendingNext = false
        if (err) {
          this._finish(resolve, err)
          return
        }

        if (key === undefined && value === undefined) {
          this._finish(resolve, null)
          return
        }

        let decoded = null
        if (value !== null) {
          try {
            decoded = this.decode(value)
          } catch (err) {
            const encErr = new EncodingError(err, 'decode in next(): ')
            this._finish(resolve, encErr)
            return
          }
        }

        resolve(new IteratorResult(
          false,
          new Result(null, new KVPair(key, decoded))
        ))
      })
    })
  }

  _batchNext (cb) {
    const self = this
    const keys = []
    const values = []

    assert(!this.asyncLevel.closed, 'cannot batchNext() after close()')
    self._iterator.next(onNext)

    function onNext (err, key, value) {
      if (err) {
        return cb(err)
      }

      if (key === undefined && value === undefined) {
        if (keys.length > 0 || values.length > 0) {
          cb(null, keys, values)
        } else {
          cb()
        }
        return
      }

      keys.push(key)
      values.push(value)

      let cache
      if (typeof self._iterator.getCache === 'function') {
        cache = self._iterator.getCache()
      } else {
        cache = self._iterator.cache
      }
      if (!cache) {
        throw new Error('LevelDown does not have cache array')
      }

      if (!self._landed) {
        self._landed = true
        if (cache.length === 0) {
          assert(!self.asyncLevel.closed, 'cannot next() after close()')
          return self._iterator.next(onNext)
        }
      }

      for (let i = cache.length - 1; i >= 0; i -= 2) {
        keys.push(cache[i])
        values.push(cache[i - 1])
      }
      cache.length = 0
      cb(null, keys, values)
    }
  }

  /**
   * This relies on the internals of `leveldown`. It will throw
   * an exception if leveldown does not support the use case.
   */
  batchNext () {
    assert(!this.asyncLevel.closed, 'cannot batchNext() after close()')
    if (this.pendingNext) {
      throw new Error(
        'It is not safe to call Iterator.batchNext() concurrently'
      )
    }
    this.pendingNext = true
    return new Promise((resolve) => {
      if (this.finished) {
        this.pendingNext = false
        return resolve(new IteratorResult(true, null))
      }

      this._batchNext((err, keys, values) => {
        this.pendingNext = false
        if (err) {
          this._finish(resolve, err)
          return
        }

        if (keys === undefined && values === undefined) {
          this._finish(resolve, null)
          return
        }

        const decodedValues = []
        for (const value of values) {
          let decoded
          try {
            decoded = this.decode(value)
          } catch (err) {
            const encErr = new EncodingError(err, 'decode in batchNext(): ')
            this._finish(resolve, encErr)
            return
          }
          decodedValues.push(decoded)
        }

        resolve(new IteratorResult(
          false,
          new Result(null, new MultiKVPair(keys, decodedValues))
        ))
      })
    })
  }

  _finish (nextResolve, err) {
    if (this.finished) {
      return onFinish(null)
    }

    this.finished = true
    assert(!this.asyncLevel.closed, 'cannot _finish() after close()')
    this._iterator.end(onFinish)

    function onFinish (finishErr) {
      if (err || finishErr) {
        return nextResolve(new IteratorResult(
          false, new Result(err || finishErr, null)
        ))
      }

      return nextResolve(new IteratorResult(true, null))
    }
  }

  [Symbol.asyncIterator] () {
    return this
  }

  async close () {
    assert(!this.asyncLevel.closed, 'cannot close() after close()')
    return new Promise((resolve) => {
      this._finish((result) => {
        const v = result.value
        resolve(new Result(v && v.err ? v.err : null, null))
      }, null)
    })
  }
}

module.exports = AsyncLevelDown

function identity (x) { return x }

function assert (val, msg) {
  if (!val) {
    throw new Error(msg || 'Assertion failed')
  }
}
