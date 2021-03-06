var chalk = require('chalk'),
  util = require('util'),
  diff = require('diff'),
  stacktrace = require('stack-trace'),
  fs = require('graceful-fs');

var config = require('./config');
var symbols = config.symbols;

var color = require('./color');
var formatTime = require('./time').formatTime;

var pad = require('./pad');

function parseEnvOptions() {
  var
    v = process.env.MOCHA_REPORTER_OPTS || '',
    s = process.env.MOCHA_REPORTER_STACK_EXCLUDE;
  return {
      stackExclude: s ? new RegExp(s) : undefined,
      hideTitles: ~v.indexOf('hide-titles'),
      hideStats: ~v.indexOf('hide-stats')
    };
}

function Reporter(runner, mochaOptions) {
  if(!runner) return;
  this.runner = runner;

  var that = this;

  this.options = parseEnvOptions();

  var stats = this.stats = { suites: 0, tests: 0, passes: 0, pending: 0, failures: 0, timeouts: 0 };
  var failures = this.failures = [];

  this.indentation = 0;

  this.files = mochaOptions.files;
  this.filesCache = {};

  runner.on('start', function() {
    stats.start = new Date;
  });

  runner.on('suite', function(suite) {
    if(!suite.root) {
      stats.suites++;
      that.indentation++;

      if(!that.options.hideTitles) {
        that.writeLine();
        that.writeLine('%s', color('suite title', suite.title));
      }
    }
  });

  runner.on('suite end', function(suite) {
    if(!suite.root) {
      that.indentation--;
    }
  });

  runner.on('test end', function(test) {
    stats.tests++;
  });

  runner.on('pass', function(test) {
    stats.passes++;

    that.writeTest(test);
  });

  runner.on('fail', function(test, err) {
    test.err = err;
    test.timedOut = test.duration >= test.timeout();
    if(test.timedOut) stats.timeouts++;
    failures.push(test);

    that.writeTest(test);
  });

  runner.on('pending', function(test) {
    stats.pending++;

    that.writeTest(test);
  });

  runner.on('end', function() {
    //console.log(runner);

    stats.end = new Date;
    stats.duration = stats.end - stats.start;

    that.indentation = 0;

    if(!that.options.hideTitles) {
      that.writeLine();
    }

    if(!that.options.hideStats) {
      that.writeStat(stats);
    }

    if(failures.length) that.writeFailures(failures);
  });
}


Reporter.prototype.writeTest = function writeTest(test) {
  var state = test.pending ? 'pending': test.state;
  var prefix = symbols[state];
  if(state == 'failed') {
    prefix = '' + (this.stats.failures + 1) + ')';
    this.stats.failures++;
  }
  this.indentation += 0.5;

  if(!this.options.hideTitles) {
    this.writeLine(
        '%s %s',
        color('option ' + state, prefix),
        color('test title ' + state, test.title + (test.timedOut ? ' (timeout)' : '')));
  }

  this.indentation -= 0.5;
}

function indent(indentation) {
  return new Array(Math.round(indentation * config.indentation)).join(' ');
}


Reporter.prototype.writeLine = function() {
  config.stream.write(indent(this.indentation) + util.format.apply(util, arguments) + '\n');
};

Reporter.prototype.writeStat = function(stats) {
  this.indentation++;
  if(stats.suites) {
    this.writeLine(color('stat', 'Executed %d tests in %d suites in %s'), stats.tests, stats.suites, formatTime(stats.duration));
  } else {
    this.writeLine(color('stat', 'Executed %d tests in %s'), stats.tests, formatTime(stats.duration));
  }
  this.indentation++;
  if(stats.tests == stats.passes)
    this.writeLine(color('pass','All passes'));
  else {
    this.writeLine(color('pass', '%d passes'), stats.passes);
    if(stats.pending)
      this.writeLine(color('pending', '%d pending'), stats.pending);
    if(stats.failures) {
      if(stats.timeouts)
        this.writeLine(color('fail', '%d failed (%d timed out)'), stats.failures, stats.timeouts);
      else
        this.writeLine(color('fail', '%d failed'), stats.failures);
    }
  }
  this.indentation -= 2;
};


Reporter.prototype.writeFailures = function(failures) {
  this.indentation++;

  failures.forEach(function(test, i) {

    var err = test.err,
      message = err.message,
      stack = err.stack,
      actual = err.actual,
      expected = err.expected,
      escape = true;

    var parsedStack = stacktrace.parse(err);

    var index = stack.indexOf(message);
    stack = stack.substr(index + message.length).split('\n').map(function(line) { return line.trim(); });

    if (err.showDiff && sameType(actual, expected)) {
      escape = false;
      err.actual = actual = stringify(canonicalize(actual));
      err.expected = expected = stringify(canonicalize(expected));
    }

    this.writeLine();
    this.writeLine('%d) ' + color('error title', '%s'), i+1, test.fullTitle());
    this.writeLine();

    this.indentation++;
    message.split('\n').forEach(function(messageLine) {
      this.writeLine(color('error message', '%s'), messageLine);
    }, this);

    if(!test.timedOut) {

      // actual / expected diff
      if ('string' == typeof actual && 'string' == typeof expected) {
        this.writeDiff(actual, expected, escape);
      }

      this.writeLine();

      var isFilesBeforeTests = true, isTestFiles = true;

      stack
          .filter(function (l) {
            return l.length > 0;
          })
          .forEach(function (line, i) {
            var fileName = parsedStack[i].getFileName(),
                lineNumber = parsedStack[i].getLineNumber(),
                columnNumber = parsedStack[i].getColumnNumber();

            if(~this.files.indexOf(fileName)) {
              isTestFiles = true;
              isFilesBeforeTests = false;
            } else {
              isTestFiles = false;
            }

            if((isTestFiles || isFilesBeforeTests) && (!this.options.stackExclude || !fileName.match(this.options.stackExclude))) {
              this.writeLine(color('error stack', line));
              this.writeStackLine(line, fileName, lineNumber, columnNumber);
            }
          }, this);
    }

    this.indentation--;

  }, this);
  this.indentation--;
};

Reporter.prototype.writeStackLineOld = function(line, fileName, lineNumber, columnNumber) {
  if (lineNumber != null) {
    if (!this.filesCache[fileName]) {
      try {
        this.filesCache[fileName] = fs.readFileSync(fileName, {encoding: 'utf8'}).split('\n');
      } catch (e) {
      }
    }
    if (this.filesCache[fileName]) {
      var lines = this.filesCache[fileName];
      var exactLine = lines[lineNumber - 1];
      this.writeLine();
      this.writeLine(color('pos', '%d') + ' | %s', lineNumber, exactLine);
      if (columnNumber != null) {
        var prefixLength = ('' + lineNumber + ' | ').length;
        var padding = new Array(prefixLength + exactLine.length);
        padding[prefixLength + columnNumber - 1] = color('pos', '^');
        this.writeLine(padding.join(' '));
      } else {
        this.writeLine();
      }
    }
  }
}

Reporter.prototype.writeStackLine = function(line, fileName, lineNumber, columnNumber) {
  if (lineNumber != null) {
    if (!this.filesCache[fileName]) {
      try {
        this.filesCache[fileName] = fs.readFileSync(fileName, {encoding: 'utf8'}).split('\n');
      } catch (e) {
      }
    }
    if (this.filesCache[fileName]) {
      var lines = this.filesCache[fileName];

      this.writeLine();

      var linenums = [lineNumber - 2, lineNumber - 1, lineNumber];

      var longestLength = linenums
        .filter(function(n) { return !!lines[n]})
        .map(function(n) {
          return ('' + (n + 1)).length;
        })
        .reduce(function(acc, n) { return Math.max(acc, n) });// O_O Omg

      linenums.forEach(function(ln) {
        var line = lines[ln];

        if(line) {
          if(ln + 1 == lineNumber) {
            if(columnNumber) {
              var lineBefore = line.substr(0, columnNumber - 1);
              var lineAfter = line.substr(columnNumber);
              line = lineBefore + color('error line pos', line[columnNumber - 1]) + lineAfter;
            }
            this.writeLine('%s | %s', color('error line pos', pad('' + (ln + 1), longestLength)), line);
          } else {
            this.writeLine('%s | %s', pad('' + (ln + 1), longestLength), line);
          }
        }
      }, this);

      this.writeLine();
    }
  }
}

function canonicalize(obj, stack) {
  stack = stack || [];

  if(stack.indexOf(obj) !== -1) return obj;

  var canonicalizedObj;

  if(Array.isArray(obj)) {
    stack.push(obj);
    canonicalizedObj = obj.map(function(item) {
      return canonicalize(item, stack);
    });
    stack.pop();
  } else if(typeof obj === 'object' && obj !== null) {
    stack.push(obj);
    canonicalizedObj = {};
    Object.keys(obj).sort().forEach(function(key) {
      canonicalizedObj[key] = canonicalize(obj[key], stack);
    });
    stack.pop();
  } else {
    canonicalizedObj = obj;
  }

  return canonicalizedObj;
}

Reporter.prototype.writeDiff = function(actual, expected, escape) {
  function cleanUp(line) {
    if (escape) {
      line = escapeInvisibles(line);
    }
    if (line[0] === '+') return colorLines('diff added', line);
    if (line[0] === '-') return colorLines('diff removed', line);
    if (line.match(/\@\@/)) return null;
    if (line.match(/\\ No newline/)) return null;
    else return line;
  }
  function notBlank(line) {
    return line != null;
  }
  var msg = diff.createPatch('string', actual, expected);
  var lines = msg.split('\n').splice(4);

  this.writeLine();
  this.writeLine(color('diff added', '+ expected') + ' ' + color('diff removed', '- actual'));
  this.writeLine();

  lines.map(cleanUp).filter(notBlank).forEach(function(line) {
    if(line.length)
      this.writeLine(line);
  }, this);
};

function stringify(obj) {
  if(obj instanceof RegExp) return obj.toString();
  return JSON.stringify(obj, null, 2);
}

function sameType(a, b) {
  return Object.prototype.toString.call(a) == Object.prototype.toString.call(b);
}

function escapeInvisibles(line) {
  return line.replace(/\t/g, '<tab>')
    .replace(/\r/g, '<CR>')
    .replace(/\n/g, '<LF>\n');
}

function colorLines(name, str) {
  return str.split('\n').map(function(str){
    return color(name, str);
  }).join('\n');
}

module.exports = Reporter;
