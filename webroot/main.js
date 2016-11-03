'use strict';

/*
  startAudio();
  startCanvas();

*/

/* learner sets up a room.  Learner can have hash to make a room.
   When teacher joins, either the specified room or a first one will be matched.

  learner should have a hash from the beginning to support file names of saved files.

  initiator is learner

  disconnect and then reconnect is not handled.  The way it should work is that the learner keeps its room on the server.

  There are two modes of disconnection; one is the learner loses socket connection to the server, and the other is to the peer.  The server case is not critical, as long as it can keep the peer, but then when the peer is also lost, the teacher may need to rejoin.  When the teacher keeps the room id, it should be possible.


  The server needs to maintain the list of active learners to allow reconnect.  When a learner disconnected from the server, the learner keeps the room id. upon learner's reconnect, it is added back to the active learners.

  Now there may be a 'full' case. Actually there are two full cases.  when two learners try to use the same room id, and when two teachers try to server the same learner.





  saving with timestamp... but how do we ensure synchronization?

  
*/
  

/****************************************************************************
* Initial setup
****************************************************************************/

// var configuration = {
//   'iceServers': [{
//     'url': 'stun:stun.l.google.com:19302'
//   }]
// };
// {'url':'stun:stun.services.mozilla.com'}

var configuration = null;

var videoCanvas = document.getElementById('videoCanvas');
var audio = document.getElementById('audio');
var teacherCursor = document.getElementById('cursor');
var sqCanvas = document.getElementById(canvasName || 'sqCanvas');
var sqContextW = 1200;
var sqContextH = 900;
if (sqCanvas) {
  var sqContext = sqCanvas.getContext('2d');
};

var fs;

function Media() {
  this.stream = null;
  this.recorder = null;
  this.writer = null;
  this.writerReady = true;
  this.chunks = [];
  this.fileName = '';
};

var canvas = new Media();
var localAudio = new Media();
var remoteAudio = new Media();
var remoteEvents = new Media();
var localEvents = new Media();

var mixedAudio = new Media();

var localEventRecorder;

var isLearner = !isTeacher;
var learnerStartTime = Date.now();
var recordingStartTime;

var offerOptions = {
  offerToReceiveAudio: 1,
  offerToReceiveVideo: 1
};

function getRoleFromURL(url) {
  var queryString = url ? url.split('?')[1] : window.location.search.slice(1);
  var obj = {};
  if (queryString) {
    // stuff after # is not part of query string, so get rid of it
    queryString = queryString.split('#')[0];

    // split our query string into its component parts
    var arr = queryString.split('&');

    for (var i = 0; i < arr.length; i++) {
      // separate the keys and the values
      var a = arr[i].split('=');

      // in case params look like: list[]=thing1&list[]=thing2
      var paramNum = undefined;
      var paramName = a[0].replace(/\[\d*\]/, function(v) {
        paramNum = v.slice(1,-1);
        return '';
      });

      // set parameter value (use 'true' if empty)
      var paramValue = typeof(a[1])==='undefined' ? true : a[1];

      // (optional) keep case consistent
      paramName = paramName.toLowerCase();
      paramValue = paramValue.toLowerCase();
      obj[paramName] = paramValue;
    }
  }
  return obj;
}

//var isTeacher = !!getRoleFromURL()['teacher'];

// Create a random room anytime the page is loaded
var room;
if (isLearner) {
  room = window.location.hash = randomToken();
}

/****************************************************************************
* Signaling server
****************************************************************************/

// Connect to the signaling server
var socket = io.connect();

socket.on('ipaddr', function(ipaddr) {
  console.log('Server IP address is: ' + ipaddr);
});

socket.on('created', function(rm, clientId) {
  console.log('Created room', rm, '- my client ID is', clientId);
});

socket.on('full', function(rm) {
  alert('Room ' + rm + ' is full. We will create a new room for you.');
  window.location.reload();
});

socket.on('ready', function(rm) {
  console.log('Socket is ready ' + rm);
  if (!isLearner) {
    room = window.location.hash = rm;
  }
  createPeerConnection(isLearner, configuration);
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

socket.on('reconnect', function(message) {
  console.log('Client reconnected:', message);
  if (isLearner) {
    socket.emit('newLearner', room);
  } else {
    socket.emit('newTeacher', room);
  }
});

socket.on('peerDisconnected', function(rm) {
  // the other disconnected from the server, but I seem to have survived as I received this.
  // if I am a learner, keep myself in and wait for a new teacher.
  // if I am a teacher, just rejoin as a new teacher
  if (peerConn) {
    peerConn.close();
    peerConn = null;
    dataChannel.close();
    dataChannel = null;
  }
  
  if (isLearner) {
    socket.emit('newLearner', room);
  } else {
    socket.emit('newTeacher', room);
  }
});

function dump() {
  socket.emit('dump');
}

function init() {
  if (isLearner) {
    setupFileSystem();
    startCanvas();
    startAudio();
    socket.emit('newLearner', room);
  } else {
    startAudio();
    socket.emit('newTeacher', room);
  }
};

init();

if (location.hostname.match(/localhost|127\.0\.0/)) {
  socket.emit('ipaddr');
}

/**
* Send message to signaling server
*/
function sendMessage(message) {
  console.log('Client sending message: ', message);
  socket.emit('message', message);
}

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

var peerConn;
var dataChannel;

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
}

function createPeerConnection(isInitiator, config) {
  console.log('Creating Peer connection as initiator?', isInitiator, 'config:',
              config);
  peerConn = new RTCPeerConnection(config);

  // send any ice candidates to the other peer
  peerConn.onicecandidate = function(event) {
    console.log('icecandidate event:', event);
    if (event.candidate) {
      sendMessage({
        type: 'candidate',
        label: event.candidate.sdpMLineIndex,
        id: event.candidate.sdpMid,
        candidate: event.candidate.candidate
      });
    } else {
      console.log('End of candidates.');
    }
  };

  setupStreams(isInitiator);
  setupChannels(isInitiator);
  startNegotiation(isInitiator);

  if (!isInitiator) {
    peerConn.ondatachannel = function(event) {
      console.log('ondatachannel:', event.channel);
      dataChannel = event.channel;
      onDataChannelCreated(dataChannel, isInitiator);
    };
  }

  peerConn.onaddstream = function(event) {
    console.log('Remote stream added.', event);
    var tracks = event.stream.getTracks();
    if (tracks.length > 0 && tracks[0].kind == 'video') {
      videoCanvas.src = window.URL.createObjectURL(event.stream);
    } else if (tracks.length > 0 && tracks[0].kind == 'audio') {
      remoteAudio.stream = event.stream;
      audio.srcObject = remoteAudio.stream;
     //window.URL.createObjectURL(event.stream);
    }
  };
};

function startNegotiation(isInitiator) {
  if (isInitiator) {
    console.log('Creating an offer');
    peerConn.createOffer(onLocalSessionCreated, logError, offerOptions);
  }
}

function setupStreams(isInitiator) {
  if (peerConn) {
    peerConn.getLocalStreams().forEach(function(s) {
      peerConn.removeStream(s)
    });

    if (canvas.stream) {
      peerConn.addStream(canvas.stream);
    }
    if (localAudio.stream) {
      peerConn.addStream(localAudio.stream);
    }
  }
}

function setupChannels(isInitiator) {
  if (isInitiator) {
    console.log('Creating Data Channel');
    dataChannel = peerConn.createDataChannel('squeak');
    onDataChannelCreated(dataChannel, isInitiator);
  }
}

function onLocalSessionCreated(desc) {
  console.log('local session created:', desc);
  peerConn.setLocalDescription(desc, function() {
    console.log('sending local desc:', peerConn.localDescription);
    sendMessage(peerConn.localDescription);
  }, logError);
}

function onDataChannelCreated(channel, isInitiator) {
  console.log('onDataChannelCreated:', channel);

  channel.onopen = function() {
    console.log('CHANNEL opened!!!');
    if (isInitiator) {
      peerConn.onnegotiationneeded = function() {
        console.log('negatiate');
        socket.emit('renegotiate', room);
      }
    };
  };

  channel.onmessage = (adapter.browserDetails.browser === 'firefox') ?
  receiveDataFirefoxFactory() : receiveDataChromeFactory();
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
  startRecordingRemoteEvents();
  startRecordingMedia(remoteAudio);
};

function startRecordingMedia(media) {
  if (!media.stream) {return;}
  if (media === mixedAudio) {
    debugger;
  }
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
        return pair[0][0].toString() + ',' + pair[0][1].toString() + ',' + pair[0][2].toString() + ',' + pair[1].toString() + '\n';
      });
      var superBuffer = new Blob(textBuffer, {type: 'text/plain'});
      remoteEvents.chunks = [];
      targetPos = remoteEvents.writer.length + superBuffer.size;
      remoteEvents.writer.write(superBuffer);
    };
  };
};

function getGetUserMedia() {
  // Note: Opera builds are unprefixed.
  return navigator.getUserMedia || navigator.webkitGetUserMedia ||
            navigator.mozGetUserMedia || navigator.msGetUserMedia;
};

function saveFiles() {
  saveCanvas();
  saveLocalAudio();
  saveRemoteAudio();
  saveRemoteEvents();
  saveMixedAudio();
};

function saveRemoteEvents() {
  return saveFile(remoteEvents, 'text/plain');
};

function saveLocalAudio() {
  return saveFile(localAudio, 'audio/webm');
};

function saveRemoteAudio() {
  return saveFile(remoteAudio, 'audio/webm');
};

function saveCanvas() {
  return saveFile(canvas, 'video/webm');
};

function saveMixedAudio() {
  return saveFile(mixedAudio, 'audio/webm');
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

function receiveDataChromeFactory() {
  var buf, count, type;

  return function onmessage(event) {
    if (typeof event.data === 'string') {
      var payload = parseInt(event.data);
      type = payload >> 24;
      var len = payload & 0xFFFFFF;
      if (type == dataTypes.event) {
        //console.log('expecting an event.');
        //renderEvent(buf);
      } else if (type == dataTypes.image) {
        buf = window.buf = new Uint8ClampedArray(len);
        count = 0;
        console.log('Expecting a total of ' + buf.byteLength + ' bytes');
      } else {
	console.log('unknown type');
      }
      return;
    }

    if (type == dataTypes.event) {
      // assuming this 12 bytes data won't get split during the transimission
      buf = new Uint32Array(event.data);
      renderEvent(buf);
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
        renderImage(buf);
      }
    }
  }
}

function receiveDataFirefoxFactory() {
  return function onmessage(event) {
    var buf = new Uint32Array(event.data);
    console.log('Done. Rendering event.');
    renderEvent(buf);
  };
}


/****************************************************************************
* Aux functions, mostly UI-related
****************************************************************************/

var eventTypes = {keydown: 0, keyup: 1, mousedown: 2, mouseup: 3, mousemove: 4};
var dataTypes = {image: 0, event: 1};

function sendEvent(evt) {
  if (dataChannel) {
    var buf = encodeEvent(evt);
    try {
      dataChannel.send(dataTypes.event << 24 | buf.byteLength);
      dataChannel.send(buf);
    } catch(e) {
      console.log('send failed', e);
    }
  }
};

function renderEvent(buf) {
  var left = 0, top = 0;
  if (sqCanvas) {
    left = sqCanvas.offsetLeft;
    top = sqCanvas.offsetTop;
  }
  teacherCursor.style.left = ((buf[1] + left).toString() + 'px');
  teacherCursor.style.top = ((buf[2] + top).toString() + 'px');

  if (remoteEvents.queuer) {
    remoteEvents.queuer(buf);
  }
};

function randomToken() {
  return Math.floor((1 + Math.random()) * 1e16).toString(16).substring(1);
}

function logError(err) {
  console.log(err.toString(), err);
}

function encodeEvent(evt) {
   var left = 0, top = 0;
   if (videoCanvas) {
     left = videoCanvas.offsetLeft;
     top = videoCanvas.offsetTop;
   }
   var v = new Uint32Array(3);
   var type = evt.type;
   v[0] = eventTypes[type];
   if (v[0] <= 1) {
     v[1] = evt.keyCode;
   } else {
     v[1] = evt.clientX - left;
     v[2] = evt.clientY - top;
   }
   return v.buffer;
}

function sendImage() {
  // Split data channel message in chunks of this byte length.
  var CHUNK_LEN = 64000;
  console.log('width and height ', sqContextW, sqContextH);
  var img = sqContext.getImageData(0, 0, sqContextW, sqContextH),
  len = img.data.byteLength,
  n = len / CHUNK_LEN | 0;

  console.log('Sending a total of ' + len + ' byte(s) of type ');
  dataChannel.send(dataTypes.image << 24 | len);

  // split the photo and send in chunks of about 64KB
  for (var i = 0; i < n; i++) {
    var start = i * CHUNK_LEN,
    end = (i + 1) * CHUNK_LEN;
    dataChannel.send(img.data.subarray(start, end));
  }

  // send the reminder, if any
  if (len % CHUNK_LEN) {
    console.log('last ' + len % CHUNK_LEN + ' byte(s)');
    dataChannel.send(img.data.subarray(n * CHUNK_LEN));
  }
}

function renderImage(data) {
  var context = videoCanvas.getContext('2d');
  var img = context.createImageData(sqContextW, sqContextH);
  img.data.set(data);
  context.putImageData(img, 0, 0);
}

function setupAudioMixer() {
  var cxt = new AudioContext();
  if (localAudio.stream && remoteAudio.stream) {

    var c1 = cxt.createMediaStreamSource(localAudio.stream.clone());
    var c2 = cxt.createMediaStreamSource(remoteAudio.stream.clone());
    var dest = cxt.createMediaStreamDestination();
    var merger = cxt.createChannelMerger(1);
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

//startRecordingMedia(mergedAudio);


