'use strict';

/* receive ids from the server.  The first element is the learner, or the host of the session.  For all others, the participant at the lower numbered index offers connection to the higher ones.

create a PeerConnection object for each peer (regardless whether the peer is lower or higher); THEN the lower one starts the negotiation.

*/

var configuration = null;

configuration = {
   'iceServers': [{
     'url': 'stun:stun.l.google.com:19302'
   }]
 };

//configuration = null;

var room;
var videoCanvas = document.getElementById('videoCanvas');
var sqCanvas = document.getElementById(canvasName || 'sqCanvas');
var lastCanvasWidth = -1;
var lastCanvasHeight = -1;
var canvasSizeTimer;

if (sqCanvas) {
  var sqContext = sqCanvas.getContext('2d');
};
appName = appName || 'Etoys';

var fs;

var myid;
var peers = {};  // {server socket id -> PeerConn};
var dataChannels = {};  // {server socket id -> DataChannel};
var remoteCursors = {}; // {server socket id -> DOM}

function Media() {
  this.stream = null;
  this.recorder = null;
  this.writer = null;
  this.writerReady = true;
  this.chunks = [];
  this.fileName = '';
};

function ensureMedia(id) {
  if (!remoteAudio[id]) {
    remoteAudio[id] = new Media();
  };
  if (!remoteEvents[id]) {
    remoteEvents[id] = new Media();
  };
  if (!remoteCursors[id]) {
    if (wantsDOMCursor) {
      var c = document.createElement("div");
      c.id = 'cursor-' + id;
      c.innerHTML = 'X';
      c.style.position = 'absolute';
      c.style.pointerEvents = 'none';
      document.body.appendChild(c);
     // videoCanvas.style.cursor = 'none';
    } else {
      c = {id: 'cursor-' + id};
    }
    remoteCursors[id] = c;
  }
};


var canvas = new Media();
var localAudio = new Media();
var localEvents = new Media();

var remoteAudio = {}; // server socket id -> Media
var remoteEvents = {}; // server socket id -> Media;

var mixedAudio = new Media();

var isLearner = !isTeacher;
var learnerStartTime = Date.now();
var recordingStartTime;

var noAudio = /noAudio=/.test(window.location.toString());

var offerOptions = {
  offerToReceiveAudio: 1,
  offerToReceiveVideo: 1
};

// Create a random room anytime the page is loaded
if (isLearner) {
  room = window.location.hash = randomToken();
} else {
  room = window.location.hash.substring(1);
};

/****************************************************************************
* Signaling server
****************************************************************************/

// Connect to the signaling server
var socket = io.connect();

socket.on('ipaddr', function(ipaddr) {
  console.log('Server IP address is: ' + ipaddr);
});

socket.on('id', function(clientId, rm) {
  console.log('id: ' + clientId);
  myid = clientId;
  if (rm) {
    console.log('Created room', rm, '- my client ID is', clientId);
  }
});

socket.on('occupied', function(rm) {
  alert('Room ' + rm + ' is full. We will create a new room for you.');
  window.location.reload();
});

socket.on('ready', function(rm, ids) {
  console.log('Room is ready ' + rm + ' ' + ids);
  if (!isLearner) {
    room = window.location.hash = rm;
  }
  createConnections(configuration, ids);
  //createPeerConnection(isLearner, configuration);
});

socket.on('readyAgain', function(rm) {
  console.log('Socket is ready again ' + rm);
  startNegotiation(isLearner);
});

socket.on('log', function(array) {
  console.log.apply(console, array);
});

socket.on('message', function(message) {
  console.log('Client received message:', message);
  signalingMessageCallback(message);
});

socket.on('uniMessage', function(message, room, from, to) {
  console.log('Client received direct message:', message + ' ' + room + ' ' + from + ' ' + to);
  multiSignalingMessageCallback(message, room, from, to);
});

socket.on('reconnect', function(message) {
  console.log('Client reconnected:', message);
  if (isLearner) {
    socket.emit('newLearner', room, appName);
  } else {
    socket.emit('newTeacher', room, appName);
  }
});

socket.on('teacherDisconnected', function(rm, id) {
  // the other disconnected from the server, but I seem to have survived as I received this.
  // if I am a learner, keep myself in and wait for a new teacher.
  // if I am a teacher, just rejoin as a new teacher
  console.log('teacherDisconnected', rm, id);
  if (peers[id]) {
    peers[id].close();
    delete peers[id];
  }
  if (dataChannels[id]) {
    dataChannels[id].close();
    delete dataChannels[id];
  }
  
  var size = Object.keys(peers).length;

  if (isLearner && size == 0) {
    //socket.emit('newLearner', room, appName);
  }
});

function sendMessage(message, room) {
  console.log('Client sending message: ', message);
  socket.emit('message', message, room);
}

function uniSendMessage(message, room, from, to) {
  console.log('Client sending message: ', message, ' to ', to);
  socket.emit('uniMessage', message, room, from, to);
}

function dump(appName) {
  socket.emit('dump', appName);
}

/****************************************************************************
* Client Initialization
****************************************************************************/

function init() {
  if (isLearner) {
    setupFileSystem();
    startCanvas();
    if (!noAudio) {
      startAudio();
    }
    socket.emit('newLearner', room, appName);
  } else {
    if (!noAudio) {
      startAudio();
    }
    socket.emit('newTeacher', room, appName);
  };

  if (appName == 'Etoys') {
    realEncodeEvent = sqEncodeEvent;
  } else if (appName == 'Snap') {
    realEncodeEvent = snapEncodeEvent;
  } else {
    realEncodeEvent = sqEncodeEvent;  // just for now
  }
};

init();

if (location.hostname.match(/localhost|127\.0\.0/)) {
  socket.emit('ipaddr');
};

/**
* Updates URL on the page so that users can copy&paste it to their peers.
*/
// function updateRoomURL(ipaddr) {
//   var url;
//   if (!ipaddr) {
//     url = location.href;
//   } else {
//     url = location.protocol + '//' + ipaddr + ':2013/#' + room;
//   }
//   roomURL.innerHTML = url;
// }

/****************************************************************************
* WebRTC peer connection and data channel
****************************************************************************/

//var peerConn;
//var dataChannel;

function localSessionCreatedFactory(conn, from, to) {
  return function onLocalSessionCreated(desc) {
    console.log('local session created:', desc);
    conn.setLocalDescription(desc, function() {
      console.log('sending local desc:', conn.localDescription);
      uniSendMessage(conn.localDescription, room, from, to);
    }, logError);
  };
};

function multiSignalingMessageCallback(message, room, from, to) {
  console.log('multi: ', message, from, to);
  var peerConn = peers[from];
  if (message.type === 'offer') {
    console.log('Got offer. Sending answer to peer: ' + from);
    peerConn.setRemoteDescription(new RTCSessionDescription(message), function() {},
                                  logError);
    peerConn.createAnswer(localSessionCreatedFactory(peerConn, myid, from), logError);

  } else if (message.type === 'answer') {
    console.log('Got answer.');
    peerConn.setRemoteDescription(new RTCSessionDescription(message), function() {},
                                  logError);

  } else if (message.type === 'candidate') {
    peerConn.addIceCandidate(new RTCIceCandidate({
      candidate: message.candidate
    }));

  } else if (message === 'bye') {
    // TODO: cleanup RTC connection?
  }
}

function signalingMessageCallback(message) {
  if (message.type === 'offer') {
    console.log('Got offer. Sending answer to peer.');
    peerConn.setRemoteDescription(new RTCSessionDescription(message), function() {},
                                  logError);
    peerConn.createAnswer(onLocalSessionCreated, logError);

  } else if (message.type === 'answer') {
    console.log('Got answer.');
    peerConn.setRemoteDescription(new RTCSessionDescription(message), function() {},
                                  logError);

  } else if (message.type === 'candidate') {
    peerConn.addIceCandidate(new RTCIceCandidate({
      candidate: message.candidate
    }));

  } else if (message === 'bye') {
    // TODO: cleanup RTC connection?
  }
};

function createConnections(config, ids) {
  var me = ids.indexOf(myid);
  console.log('createConnections', me, ids);
  var newPeers = {};
  for (var i = 0; i < ids.length; i++) {
    if (i != me) {
      var id = ids[i];
      var conn = peers[id];
      if (conn && conn.connectionState == "connected") {
        newPeers[id] = conn;
      } else {
        newPeers[id] = createPeerConnection(me < i, config, id);
      }
    }
  }
  for (var k in peers) {
    if (ids.indexOf(k) < 0) {
      peers[k].close();
    }
  }
  peers = newPeers;

  for (var k in peers) {
    var other = ids.indexOf(k);
    var isInitiator = me < other;
    setupStreams(isInitiator, k);
    setupChannels(isInitiator, k);
    startNegotiation(isInitiator, k);
    ensureMedia(k);
  };
  console.log("after setting up peers: ", peers);
};

function createPeerConnection(isInitiator, config, id) {
  console.log('Creating Peer connection as initiator?', isInitiator, 'config:',
              config, ' to ', id);
  return (function() {
    var peerConn = new RTCPeerConnection(config);
    var connID = id;

    // send any ice candidates to the other peer
    peerConn.onicecandidate = function(event) {
      console.log('icecandidate event:', event);
      if (event.candidate) {
        uniSendMessage({
          type: 'candidate',
          label: event.candidate.sdpMLineIndex,
          id: event.candidate.sdpMid,
          candidate: event.candidate.candidate
        }, room, myid, id);
      } else {
        console.log('End of candidates.');
      }
    };

    if (!isInitiator) {
      peerConn.ondatachannel = function(event) {
        var dataChannel = event.channel;
        onDataChannelCreated(dataChannel, isInitiator, peerConn, id);
        dataChannels[id] = dataChannel;
      };
    };

    peerConn.onaddstream = function(event) {
      console.log('Remote stream added.', event);
      var tracks = event.stream.getTracks();
      if (tracks.length > 0 && tracks[0].kind == 'video') {
        videoCanvas.src = window.URL.createObjectURL(event.stream);
      } else if (tracks.length > 0 && tracks[0].kind == 'audio') {
        remoteAudio[connID].stream = event.stream;
        var audio = document.createElement('audio');
        audio.autoplay = true;
        audio.id = 'audio-' + connID;
        document.body.appendChild(audio);
        audio.srcObject = remoteAudio[connID].stream;
      }
    };

    return peerConn;
  })();
};

function startNegotiation(isInitiator, id) {
  var peerConn = peers[id];
  if (isInitiator) {
    console.log('Creating an offer');
    peerConn.createOffer(localSessionCreatedFactory(peerConn, myid, id), logError, offerOptions);
  }
};

function setupStreams(isInitiator, id) {
  var peerConn = peers[id];
  var stream;
  if (peerConn) {
    peerConn.getLocalStreams().forEach(function(s) {
      peerConn.removeStream(s)
    });

    if (canvas.stream) {
      stream = canvas.stream.clone();
      peerConn.addStream(stream);
    }
    if (localAudio.stream) {
      stream = localAudio.stream.clone();
      peerConn.addStream(stream);
    }
  }
};

function setupChannels(isInitiator, id) {
  var peerConn = peers[id];
  if (isInitiator) {
    console.log('Creating Data Channel for ' + id);
    var dataChannel = peerConn.createDataChannel('channel' + id);
    onDataChannelCreated(dataChannel, isInitiator, peerConn, id);
    dataChannels[id] = dataChannel;
  }
}

function onLocalSessionCreated(desc) {
  console.log('local session created:', desc);
  peerConn.setLocalDescription(desc, function() {
    console.log('sending local desc:', peerConn.localDescription);
    sendMessage(peerConn.localDescription, room);
  }, logError);
}

function onDataChannelCreated(channel, isInitiator, peerConn, id) {
  console.log('onDataChannelCreated:', id, channel);

  channel.onopen = function() {
    console.log('CHANNEL opened!!!');
    if (isInitiator) {
      peerConn.onnegotiationneeded = function() {
        socket.emit('renegotiate', room);
      }
      if (sqCanvas) {
        console.log('reset canvas');
        // there must be a better way to test it but this means that this is the learner
        if (canvasSizeTimer) {
           clearInterval(canvasSizeTimer);
           canvasSizeTimer = null;
        }
        canvasSizeTimer = setInterval(sendCanvasSize, 1000);
        lastCanvasWidth = -1;
        lastCanvasHeight = -1;
        sqSendEvent = sendEvent;
        if (window.sqStartUp) {
          sqStartUp();
        };
      }
    };
  };

  channel.onmessage = (adapter.browserDetails.browser === 'firefox') ?
    receiveDataFirefoxFactory(id) : receiveDataChromeFactory(id);
};

function startCanvas() {
  canvas.stream = sqCanvas.captureStream(30);
};

function startAudio() {
  var f = getGetUserMedia();
  if (f) {
    f({audio: true, video: false},
      function(stream) {
        localAudio.stream = stream;
      },
      function(err) {console.log(err)});
  }
};

function startRecording() {
  recordingStartTime = Date.now();
  startRecordingMedia(canvas);
  startRecordingMedia(localAudio);
//  startRecordingRemoteEvents();
//  startRecordingMedia(remoteAudio);
};

function startRecordingMedia(media) {
  if (!media.stream) {return;}
  var cloned = media.stream.clone();
  media.recorder = new MediaRecorder(cloned);
  media.recorder.start();
  var targetPos;
  media.recorder.ondataavailable = function handleDataAvailable(event) {
    if (event.data.size > 0) {
      media.chunks.push(event.data);
      if (media.writerReady) {
        if (!media.writer.onwriteend) {
          media.writer.onwriteend = function(e) {
            if (media.writer.length == targetPos) {
              media.writerReady = true;
              media.writer.seek(media.writer.length); // Start write position at EOF.
            }
          };
          media.writer.onerror = function(e) {
           console.log('Write failed: ' + e.toString());
          };
        }
        media.writerReady = false;
        var superBuffer = new Blob(media.chunks, {type: 'video/webm'});
        media.chunks = [];
        targetPos = media.writer.length + superBuffer.size;
        media.writer.write(superBuffer);
      }
    };
  };
};

function startRecordingCanvas() {
  return startRecordingMedia(canvas);
}

function startRecordingAudio() {
  return startRecordingMedia(localAudio);
}

function startRecordingRemoteAudio() {
  return startRecordingMedia(remoteAudio);
}

function startRecordingRemoteEvents() {
  var targetPos;
  remoteEvents.queuer = function(event) {
    remoteEvents.chunks.push([event, Date.now()]);
    if (remoteEvents.writerReady) {
      if (!remoteEvents.writer.onwriteend) {
        remoteEvents.writer.onwriteend = function(e) {
          if (remoteEvents.writer.length == targetPos) {
            remoteEvents.writerReady = true;
            remoteEvents.writer.seek(remoteEvents.writer.length);
          }
        };
        remoteEvents.writer.onerror = function(e) {
         console.log('Write failed: ' + e.toString());
        };
      };
      remoteEvents.writerReady = false;
      var textBuffer = remoteEvents.chunks.map(function(pair) {
        var e = "";
        for (var i = 0; i < pair[0].length; i++) {
          e = e + pair[0][i].toString() + ",";
        }
        e = e + pair[1].toString() + '\n';
        return e;
      });
      var superBuffer = new Blob(textBuffer, {type: 'text/plain'});
      remoteEvents.chunks = [];
      targetPos = remoteEvents.writer.length + superBuffer.size;
      remoteEvents.writer.write(superBuffer);
    };
  };
};

function setupAudioMixer() {
  var cxt = new AudioContext();
  if (localAudio.stream && remoteAudio.stream) {
    var c1 = cxt.createMediaStreamSource(localAudio.stream.clone());
    var c2 = cxt.createMediaStreamSource(remoteAudio.stream.clone());
    var dest = cxt.createMediaStreamDestination();
    var merger = cxt.createChannelMerger(2);
    c1.connect(merger, 0, 0);
    c2.connect(merger, 0, 1);
    merger.connect(dest);
    mixedAudio.stream = dest.stream;
  }
}

function startRecordingMixedAudio() {
  setupAudioMixer();
  return startRecordingMedia(mixedAudio);
}

function getGetUserMedia() {
  // Note: Opera builds are unprefixed.
  return navigator.getUserMedia || navigator.webkitGetUserMedia ||
            navigator.mozGetUserMedia || navigator.msGetUserMedia;
};

function saveFiles() {
  saveFile(canvas, 'video/webm');
  saveFile(localAudio, 'audio/webm');
//  saveFile(remoteAudio, 'audio/webm');
  saveFile(remoteEvents, 'text/plain');
//  saveFile(mixedAudio, 'audio/webm');
};

function saveFile(media, type) {
  if (fs) {
    fs.root.getFile(media.fileName, {create: false}, function(fileEntry) {
      fileEntry.file(function(file) {
        var reader = new FileReader();
        reader.onloadend = function(e) {
          var blob = new Blob([reader.result], {type: type});
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          document.body.appendChild(a);
          a.style = 'display: none';
          a.href = url;
          a.download = media.fileName;
          a.click();
          window.URL.revokeObjectURL(url);
        };
        reader.readAsArrayBuffer(file);
      });
    });
  };
};

function fsErrorHandler(e) {
  console.log('Error: ' + e);
};

function setupFileSystem() {
  var success = function(files) {
    fs = files;
    [
      [canvas, 'canvas-' + room + '.webm'],
      [localAudio, 'localAudio-' + room + '.webm'],
      [remoteAudio, 'remoteAudio-' + room + '.webm'],
      [mixedAudio, 'mixedAudio-' + room + '.webm'],
      [remoteEvents, 'remoteEvents-' + room + '.txt']].forEach(function(pair) {
        pair[0].fileName = pair[1];
        fs.root.getFile(pair[1], {create: true}, function(fileEntry) {
          console.log('file: ' + pair[1] + ' created');
          fileEntry.createWriter(function(fileWriter) {
          fileWriter.truncate(0);
          pair[0].writer = fileWriter;
        });
      }); 
    });
  };
  window.webkitRequestFileSystem(window.TEMPORARY, 1024 * 1024 * 2, success, fsErrorHandler);
};

function receiveDataChromeFactory(id) {
  var buf, count, type;

  return function onmessage(event) {
    if (typeof event.data === 'string') {
      var payload = parseInt(event.data);
      type = payload >> 24;
      var len = payload & 0xFFFFFF;
      if (type == dataTypes.event) {
        //console.log('expecting an event.');
      } else if (type == dataTypes.image) {
        buf = window.buf = new Uint8ClampedArray(len);
        count = 0;
        console.log('Expecting a total of ' + buf.byteLength + ' bytes');
      } else if (type == dataTypes.canvasSize) {
        //console.log('expecting a canvas size spec.');
      } else {
	console.log('unknown type');
      }
      return;
    }

    if (type == dataTypes.event) {
      // assuming this 20 bytes data won't get split during transimission
      buf = new Uint32Array(event.data);
      receiveEvent(buf, id);
      buf = null;
      type = null;
    } else if (type == dataTypes.image) {
      var data = new Uint8ClampedArray(event.data);
      buf.set(data, count);
      count += data.byteLength;
      console.log('count: ' + count);

      if (count === buf.byteLength) {
        // we're done: all data chunks have been received
        console.log('Done. Rendering image.');
        receiveImage(buf);
      }
    } else if (type == dataTypes.canvasSize) {
      // assuming this 8 bytes data won't get split during transimission
      buf = new Uint32Array(event.data);
      receiveCanvasSize(buf);
      buf = null;
      type = null;
    }
  }
};

function receiveDataFirefoxFactory(id) {
  return function onmessage(event) {
    var buf = new Uint32Array(event.data);
    console.log('Done. Rendering event.');
    receiveEvent(buf, id);
  };
};

var eventTypes = {keydown: 0, keyup: 1, keypress: 2, mousedown: 3, mouseup: 4, mousemove: 5};
var dataTypes = {image: 0, event: 1, canvasSize: 2};

function randomToken() {
  return Math.floor((1 + Math.random()) * 0x1000).toString(8).substring(1);
//  return Math.floor((1 + Math.random()) * 1e16).toString(16).substring(1);
}

function logError(err) {
  console.log(err.toString(), err);
}

function sendEvent(evt) {
  var buf = encodeEvent(evt);
  if (!buf) {return;}
  for (var k in dataChannels) {
    var dataChannel = dataChannels[k];
    try {
      dataChannel.send(dataTypes.event << 24 | buf.byteLength);
      dataChannel.send(buf);
    } catch(e) {
      console.log('send failed', e, ' to ', k);
    }
  }
  if (localEvents.queuer) {
    localEvents.queuer(buf);
  }
};

var realEncodeEvent;

function snapEncodeEvent(evt, posX, posY) {
  var key, buttons, evtType;
  var v = new Uint32Array(7);  // [type, posX, posY, keyCode, modifiers, buttons, button]
  v[0] = eventTypes[evt.type];
  v[1] = posX;
  v[2] = posY;
  switch (evt.type) {
    case 'mousedown':
    case 'mouseup':
    case 'mousemove':
      v[5] = evt.buttons;
      v[6] = evt.button;
      break;
    case 'keydown':
    case 'keypress':
    case 'keyup':
      v[3] = evt.keyCode;
      var mod = 0;
      if (evt.metaKey) {mod = mod | 1};
      if (evt.altKey) {mod = mod | 2};
      if (evt.ctrlKey) {mod = mod | 4};
      if (evt.shiftKey) {mod = mod | 8};
      v[4] = mod;
      break;
  }
  return v.buffer;
};

function sqEncodeEvent(evt, posX, posY) {
  var key, buttons, code;

  var v = new Uint32Array(5);  // [type, posX, posY, key, buttons]
 
  var squeakCode = ({
            8: 8,   // Backspace
            9: 9,   // Tab
            13: 13, // Return
            27: 27, // Escape
            32: 32, // Space
            33: 11, // PageUp
            34: 12, // PageDown
            35: 4,  // End
            36: 1,  // Home
            37: 28, // Left
            38: 30, // Up
            39: 29, // Right
            40: 31, // Down
            45: 5,  // Insert
            46: 127, // Delete
  })[evt.keyCode];
    
  function encodeModifiers(evt) {
    var shiftPressed = evt.shiftKey,
      ctrlPressed = evt.ctrlKey && !evt.altKey,
      cmdPressed = evt.metaKey || (evt.altKey && !evt.ctrlKey),
      modifiers =
        (shiftPressed ? 8 : 0) +
        (ctrlPressed ? 16 : 0) +
        (cmdPressed ? 64 : 0);
    return modifiers;
  };

  buttons = 0;
  switch (evt.buttons || 0) {
    case 1: buttons = 4; break;      // left
    case 2: buttons = 2; break;   // middle
    case 4: buttons = 1; break;     // right
  };

  v[0] = eventTypes[evt.type];
  v[1] = posX;
  v[2] = posY;
  v[3] = evt.keyCode;
  v[4] = buttons + encodeModifiers(evt);
  if (squeakCode) {
    if (evt.type == 'keydown') { // special key pressed
      v[0] = eventTypes['keypress']; // probably a bug workaround
      v[3] = squeakCode;
      evt.preventDefault();
    }
  } else if ((evt.metaKey || (evt.altKey && !evt.ctrlKey))) {
    code = evt.keyCode;
    key = evt.key; // only supported in FireFox, others have keyIdentifier
    if (!key && evt.keyIdentifier && evt.keyIdentifier.slice(0,2) == 'U+') {
      key = String.fromCharCode(parseInt(evt.keyIdentifier.slice(2), 16));
    }
    if (key && key.length == 1) {
      var code = key.charCodeAt(0);
      if (/[A-Z]/.test(key) && !evt.shiftKey) code += 32;  // make lower-case
    }
    v[3] = code;
    evt.preventDefault();
  }
  return v.buffer;
};

function encodeEvent(evt) {
   var left = 0, top = 0, scale = 1;
   if (isTeacher && videoCanvas) {
     var rect = videoCanvas.getBoundingClientRect();
     left = rect.left;
     top = rect.top;
     if (lastCanvasWidth > 0) {
       scale = lastCanvasWidth / rect.width;
     }
   } else if (isLearner && sqCanvas) {
     var rect = sqCanvas.getBoundingClientRect();
     left = rect.left;
     top = rect.top;
     if (lastCanvasWidth > 0) {
       scale = lastCanvasWidth / rect.width;
     }
   };
  return realEncodeEvent(evt, (evt.clientX - left) * scale, (evt.clientY - top) * scale);
};

function receiveEvent(buf, id) {
  var left = 0, top = 0, scale = 1, offX = 0, offY = 0;
  var remoteCursor = remoteCursors[id];
  if (!remoteCursor) {return;}
  if (sqCanvas) {
    var rect = sqCanvas.getBoundingClientRect();
    left = rect.left;
    top = rect.top;
    scale = rect.width / sqCanvas.width;
  } else if (videoCanvas) {
    var rect = videoCanvas.getBoundingClientRect();
    left = rect.left;
    top = rect.top;
    scale = rect.width / lastCanvasWidth;
  }

  if (wantsDOMCursor) {
    offX = remoteCursor.getBoundingClientRect().width / 2;
    offY = remoteCursor.getBoundingClientRect().height / 2;

    var posX = (buf[1] * scale) + left - offX;
    var posY = (buf[2] * scale) + top - offY;

    remoteCursor.style.left = posX.toString() + 'px';
    remoteCursor.style.top = posY.toString() + 'px';
  }

  if (remoteCursor.sqRcvEvt) {
    remoteCursor.sqRcvEvt(buf);
  };

  if (remoteEvents[id].queuer) {
    var t = v[0];
    if (type <= 1) {
      var buf = [t, buf[1]];
    } else {
      var buf = [t, posX, posY];
    }
    remoteEvents[id].queuer(buf);
  }
};

function sendCanvasSize() {
  var nowW = sqCanvas.width;
  var nowH = sqCanvas.height;
  if (nowW == lastCanvasWidth &&
      nowH == lastCanvasHeight) {
    return;
  }
  for (var k in dataChannels) {
    var dataChannel = dataChannels[k];
    var buf = new Uint32Array(2);
    buf[0] = nowW;
    buf[1] = nowH;
    try {
      dataChannel.send(dataTypes.canvasSize << 24 | buf.byteLength);
      dataChannel.send(buf);
    } catch(e) {
      console.log('send failed', e, ' to ', k);
      return;
    }
  }
  lastCanvasWidth = nowW;
  lastCanvasHeight = nowH;
};

// function sendImage() {
//   // Split data channel message in chunks of this byte length.
//   var CHUNK_LEN = 64000;
//   console.log('width and height ', sqContextW, sqContextH);
//   var img = sqContext.getImageData(0, 0, sqContextW, sqContextH),
//   len = img.data.byteLength,
//   n = len / CHUNK_LEN | 0;

//   console.log('Sending a total of ' + len + ' byte(s) of type ');
//   dataChannel.send(dataTypes.image << 24 | len);

//   // split the photo and send in chunks of about 64KB
//   for (var i = 0; i < n; i++) {
//     var start = i * CHUNK_LEN,
//     end = (i + 1) * CHUNK_LEN;
//     dataChannel.send(img.data.subarray(start, end));
//   }

//   // send the reminder, if any
//   if (len % CHUNK_LEN) {
//     console.log('last ' + len % CHUNK_LEN + ' byte(s)');
//     dataChannel.send(img.data.subarray(n * CHUNK_LEN));
//   }
// }

function receiveImage(data) {
  var context = videoCanvas.getContext('2d');
  var img = context.createImageData(sqContextW, sqContextH);
  img.data.set(data);
  context.putImageData(img, 0, 0);
};

function receiveCanvasSize(data) {
  var w = data[0];
  var h = data[1];
  console.log("w, h = " + w + ", " + h);
  lastCanvasWidth = w;
  lastCanvasHeight = h;
  videoCanvas.style.width = (w.toString() + 'px');
  videoCanvas.style.height = (h.toString() + 'px');
};

//startRecordingMedia(mergedAudio);
