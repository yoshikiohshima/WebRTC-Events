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

function findAvailableFrom(queue) {
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
}

function cleanupIn(queue, sock) {
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
}

function maybeStart() {
    var teacher = findAvailableFrom(teachersQueue);
    var learner = findAvailableFrom(learnersQueue);
    if (teacher && learner) {
      teachersQueue.shift();
      learnersQueue.shift();
      var socket = teacher[0];
      var room = teacher[1];
      socket.join(room);
      learner[0].join(room);
      io.sockets.in(room).emit('ready', room);
    }
}


var io = socketIO.listen(app);
io.sockets.on('connection', function(socket) {

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
    log('a new teacher is creating a room: ' + room);
    socket.emit('created', room, socket.id);
    teachersQueue.push([socket, room]);
    maybeStart();
  });

  socket.on('newLearner', function () {
    log('a new learner joined: ');
    learnersQueue.push([socket]);
    maybeStart();
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
  });

  socket.on('renegotiate', function(room) {
    console.log('renegotiation in room: ' + room);
    io.sockets.in(room).emit('readyAgain', room);
  });

  socket.on('reset', function(){
    console.log('reset queues');
    teachersQueue = [];
    learnersQueue = [];
  });
});
