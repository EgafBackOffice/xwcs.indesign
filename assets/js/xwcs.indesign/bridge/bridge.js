﻿/******************************************************************************
 * Copyright (C) 2016-2017 0ics srls <mail{at}0ics.it>
 * 
 * This file is part of xwcs libraries
 * xwcs libraries and all his part can not be copied 
 * and/or distributed without the express permission 
 * of 0ics srls
 *
 ******************************************************************************/

/*
    CsBridge singleton
*/

var CsBridge = (function (ind, opt) {
  // this will help mantain C# <-> IND compatibility
  const _CsBridge_version = '2.1.12';

  // private closure
  var _indesign = ind;

  /// @Socket
  var _tube = null;

  /// @Logger
  var _logger = null;

  // arrive from id_standalone.js or as DoScript params from C#
  var _opt = opt;

  var _listenersMap = {};

  // current url connection
  var _currentUrl = "";

  /*
      map of elements
      {
          sender : <sender>
          kind: <event kind>
      }
  */
  var _handlers = new Object();


  var __eventHandler = function (eventKind, evt) {
    __log("Event: " + eventKind);

    var ret = __sendMessage("JsEvent", {
      bubbles: evt.bubbles,
      cancelable: evt.cancelable,
      defaultPrevented: evt.defaultPrevented,
      eventType: evt.eventType,
      id: evt.id,
      index: evt.index,
      isValid: evt.isValid,
      propagationStopped: evt.propagationStopped,
      timeStamp: evt.timeStamp,
      currentTargetID: evt.currentTarget.id,
      parentID: evt.parent.id,
      targetID: evt.target.id,
      eventKind: eventKind
    });

    __logResult(ret);

  };

  var __logResult = function (result) {
    if (result.status == 'ok') {
      if (result.hasOwnProperty('data')) {
        __log(JSON.stringify(result.data));
      } else {
        __log(JSON.stringify(result));
      }
    } else {
      __log('Error:' + result.msg);
    }
  };

  var __getMessageKind = function (kindStr) {
    switch (kindStr) {
      case 'JsEvent': return 1;
      case 'JsAction': return 2;
      case 'JsTaskResult': return 3;
      case 'JsPing':
      default: return 0; // ping
    }
  };

  var __padNumber = function (num, size) {
    var s = "000000000" + num;
    return s.substr(s.length - size);
  };

  var __byteLength = function (str) {
    // returns the byte length of an UTF-8 string
    var s = str.length;
    for (var i = str.length - 1; i >= 0; i--) {
      var code = str.charCodeAt(i);
      if (code > 0x7f && code <= 0x7ff) s++;
      else if (code > 0x7ff && code <= 0xffff) s += 2;
      if (code >= 0xDC00 && code <= 0xDFFF) i--; //trail surrogate
    }
    return s;
  };

  var __sendMessage = function (kindStr, what) {

    what.DataKindType = __getMessageKind(kindStr);

    var msg = JSON.stringify({
      id: 1,
      data: what
    });
    msg = Base64.encode(msg);
    var msgLen = __padNumber(__byteLength(msg), 10);
    // send data
    __log(" _tube.write: " + msg);
    _tube.write(msgLen, msg);

    __log("About to read size");
    // parse input message
    // it will first arrive 10 chars length
    var sizeStr = _tube.read(10);
    if (sizeStr.length > 10) {
      // wire error reset socket
      __log("Read timeout ...");
      __connect(_currentUrl);
      return { status: 'error', msg: "Read timout" };
    }
    // parse len
    var len = parseInt(sizeStr, 10);
    if (isNaN(len)) {
      __log("Read size problem ...");
      __connect(_currentUrl);
      return { status: 'error', msg: "Read timout" };
    }
    // now read len chars
    __log("About to read " + len + " bytes");

    // From https://rorohiko.blogspot.com/2013/01/geturlsjsx.html
    // ... If we let the socket interpret UTF-8 then the body length we get from the header,
    // and the number of characters we receive won't match - which makes things quite awkward ...
    // For CEP Version: https://coppieters.nz/?p=133
    //
    // Ivan - Finally I use socket in ASCII mode, with the UTF-8 text encoded base64.
    // Base64 library from with http://www.webtoolkit.info/javascript_base64.html
    // 
    var result = _tube.read(len);
    var resultLength = result.length;
    __log("result: " + result + " resultLength: " + resultLength);


    if (resultLength < len) {
      __log("Read msg problem: resultLength<>len: " + resultLength + "<>" + len);
      __connect(_currentUrl);
      return { status: 'error', msg: "Read timout" };
    }
    __log("Arrived : " + len + " chars")
    try {
      var d = JSON.parse(Base64.decode(result));
      if (d.hasOwnProperty("status")) {
        return d;
      } else {
        return { status: 'ok', data: d };
      }
    } catch (e) {
      return { status: 'error', msg: e.message };
    }
  };

  // private functions
  var __connected = function () {
    return _tube != null && _tube.connected;
  };

  var __connect = function (url) {
    if (__connected()) {
      __log("Connected ... reopen ...");
      _tube.close();
    }
    __log("_currentUrl: " + url + " _opt.encoding: " + _opt.encoding);
    _currentUrl = url;
    _tube = new Socket;
    __log("Before connected");
    if (_tube.open(url, _opt.encoding)) {
      __log("Connected. Url: " + url + " encoding: " + _opt.encoding);
      _tube.timeout = _opt.timeout;
      return true;
    }
    // not good
    __log("Cant connect to C# server!");
    _tube = null;
    return false;
  };

  var __merge_options = function (opt) {
    for (v in opt) {
      _opt[v] = opt[v];
    }
  };

  var __log = function (msg) {
    $.writeln(msg);
    if (_logger == null) {
      _logger = LoggerFactory.getLogger(_opt.log);
    }
    _logger.log("CsBridge : " + msg);
  };


  // do init work


  //1:    create idle task for some sort of async management
  //      this task will be activated when there will be async call
  var _asyncTaskCounter = 0;
  var __registerTask = function (what) {
    var _asyncTask = _indesign.idleTasks.add({ name: 'CsBridge_idle_task' + _asyncTaskCounter, sleep: 0 }); // it will not run for now

    __log("Async task : " + _asyncTaskCounter + " registered!");

    // add handler closure
    _asyncTask.addEventListener(IdleEvent.ON_IDLE, function (evt) {
      __asyncTaskHandler(what, evt);
    });
    // activate task
    _asyncTask.sleep = 1;

    return what.taskId;
  };
  var __asyncTaskHandler = function (job, evt) {
    __log("Async task handler ...");
    evt.parent.sleep = 0; // stop handling task here, putting almost infinite wait

    __log("Async task handler ... Start run task " + job.taskId + " ...");
    var ret = job.task();
    __log("Async task handler ... Task done ...");

    // send back status if possible , in case of failed ping it will stop here 
    __log("Async task handler ... Sending result ...");
    var ret = __sendMessage("JsTaskResult", {
      taskId: job.taskId,
      status: ret
    });
    __log("Async task handler ... Returned ..." + JSON.stringify(ret));
  };

  // some message
  __log("CsBridge Started (" + _CsBridge_version + ")");

  // return public interface
  return {
    version: function () {
      return _CsBridge_version;
    },
    open: function (options) {
      try {
        __merge_options(options);

        __log("Connecting ...");

        return __connect(_opt.url);
      } catch (e) {
        __log(e.message);
      }
    },
    addEventHandler: function (evtSource, evtKind) {
      // first check event listener presence
      // we look for label   :   CsBridge + evtSource.Id + evtKind
      var label = 'CsBridge_' + evtSource.id + '-' + evtKind;
      if (_listenersMap.hasOwnProperty(label)) {
        // we have old listener already
        // so just return
        __log("Skipped add handler : " + label);
        return;
      }
      var listener = evtSource.addEventListener(evtKind, function (evt) {
        __eventHandler(evtKind, evt);
      });
      _listenersMap[label] = listener.id;
      __log("Added handler : " + label);
    },
    close: function () {
      _tube.close();
    },
    ping: function () {
      __log("Sending ping ...");
      var ret = __sendMessage('JsPing', {});
      if (ret.status == 'ok') {
        __log("Ping OK!");
        return true;
      }
      __log("Ping FAIL!");
      return false;
    },
    runAsync: function (what) {
      // we need send counter value from here cause inside it will use closure
      return __registerTask({
        taskId: _asyncTaskCounter++,
        task: what
      });
    },
    options: function () {
      return _opt;
    },

    log: function (msg) {
      __log(msg);
    },

    doAction: function (what) {
      __log("Sending Action ...");
      var ret = __sendMessage('JsAction', what);
      if (ret.status == 'ok') {
        __log("Action OK!");
        return ret.data;
      }
      __log("Action FAIL!");
      throw ret.msg;
    },
    // public property
    Indesign: function () { return _indesign; }
  };
})(
    app,
    // options overwrite
    {
      url: '',
      log: arguments[0],
      scriptPath: arguments[1],
      encoding: arguments[2] || "ASCII", // { "ASCII", "BINARY", or "UTF-8"}
      timeout: arguments[3] || 600 // seconds
    }
);