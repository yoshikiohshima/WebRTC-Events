'use strict';

var os = require('os');
var fs = require('fs');
var nodeStatic = require('node-static');
var fileServer = new(nodeStatic.Server)('webroot');
var socketIO = require('socket.io');

if (process.argv.length > 2) {
  var server = require('https');
  var serverOptions = {
    key: fs.readFileSync('privkey1.pem'),
    cert: fs.readFileSync('cert1.pem')
  };
  var app = server.createServer(serverOptions, function(req, res) {
    fileServer.serve(req, res);
  });
} else {
  var server = require('http');
  var app = server.createServer(function(req, res) {
    fileServer.serve(req, res);
  });
}

app.listen(8080);

var teachersQueue = [];
var learnersQueue = [];
var learners = {}; // room -> socket;
var teachers = {}; // room -> socket;

function addLearner(socket, room) {
  if (learners[room] && learners[room].connected) {
    return 'in use';
  }
  learnersQueue.push([socket, room]);
  learners[room] = socket;
  return 'added';
};

function removeLearner(socket) {
  for (var k in learners) {
    if (learners[k] === socket) {
      delete learners[k];
    }
  }
  return false;
};

function isLearner(socket) {
  for (var k in learners) {
    if (learners[k] === socket) {
      return true;
    }
  }
  return false;
};

function roomFromSocket(socket) {
  for (var k in learners) {
    if (learners[k] === socket) {
      return k;
    }
  }
  for (var k in teachers) {
    if (teachers[k] === socket) {
      return k;
    }
  }
  return null;
}

function findFirstAvailableFrom(queue) {
  while (true) {
    if (queue.length == 0) {
      return null;
    }
    var elem = queue[0];
    if (elem[0].connected) {
      return elem;
    } else {
      queue.shift();
    }
  }
};

function findMatchFor(pair, queue) {
  var room = pair[1];
  while (true) {
    if (queue.length == 0) {
      return null;
    }
    var elem = queue[0];
    if (elem[0].connected && (elem[1] === room || !elem[1])) {
      return elem;
    } else {
      queue.shift();
    }
  }
};

function maybeStart() {
  console.log("maybeStart");
  var learner = findFirstAvailableFrom(learnersQueue);
  if (learner) {
    console.log('l: ' + learner[1]);
    var teacher = findMatchFor(learner, teachersQueue);
  }
  if (teacher && learner) {
    console.log('t: ' + teacher[1]);
    teachersQueue.shift();
    learnersQueue.shift();
    var socket = learner[0];
    var room = learner[1];
    socket.join(room);
    teacher[0].join(room);
    teachers[room] = teacher[0];
    io.sockets.in(room).emit('ready', room);
  }
  console.log('end of maybeStart()');
}

var io = socketIO.listen(app);
io.sockets.on('connection', function(socket) {
  console.log('connected: ' + socket.id);

  // convenience function to log server messages on the client
  function log() {
    var array = ['Message from server:'];
    array.push.apply(array, arguments);
    socket.emit('log', array);
  }

  socket.on('message', function(message) {
    log('Client said: ', message);
    // for a real app, would be room-only (not broadcast)
    socket.broadcast.emit('message', message);
  });

  socket.on('newTeacher', function(room) {
    log('a new teacher is looking for a room: ' + room);
    teachersQueue.push([socket, room]);
    maybeStart();
  });

  socket.on('newLearner', function (room) {
    log('a new learner with a room: ' + room);
    socket.emit('created', room, socket.id);
    var result = addLearner(socket, room);
    if (result === 'added') {
      maybeStart();
    } else if (result === 'in use') {
      socket.emit('full', room);
    }
  });
  
  socket.on('ipaddr', function() {
    var ifaces = os.networkInterfaces();
    for (var dev in ifaces) {
      ifaces[dev].forEach(function(details) {
        if (details.family === 'IPv4' && details.address !== '127.0.0.1') {
          socket.emit('ipaddr', details.address);
        }
      });
    }
  });

  socket.on('bye', function() {
    console.log('received bye');
  });

  socket.on('disconnect', function() {
    console.log('disconnected');
    var room = roomFromSocket(socket);
    console.log('room: ' + room);
    if (room) {
      delete learners[room];
      io.sockets.in(room).emit('peerDisconnected', room);
    }
  });

  socket.on('renegotiate', function(room) {
    console.log('renegotiation in room: ' + room);
    io.sockets.in(room).emit('readyAgain', room);
  });

  socket.on('reset', function() {
    console.log('reset queues');
    teachersQueue = [];
    learnersQueue = [];
    learners = {};
  });

  socket.on('dump', function() {
    console.log('dump');
    console.log(learners);
    console.log(learnersQueue);
    console.log(teachersQueue);
  });
});
