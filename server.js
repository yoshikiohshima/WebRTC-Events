'use strict';

var os = require('os');
var fs = require('fs');
var nodeStatic = require('node-static');
var fileServer = new(nodeStatic.Server)('webroot');
var socketIO = require('socket.io');

if (process.argv.length > 2) {
  var mod = require('https');
  var serverOptions = {
    key: fs.readFileSync('privkey1.pem'),
    cert: fs.readFileSync('cert1.pem')
  };
  var server = mod.createServer(serverOptions, function(req, res) {
    fileServer.serve(req, res);
  });
} else {
  var mod = require('http');
  var server = mod.createServer(function(req, res) {
    fileServer.serve(req, res);
  });
};

server.listen(8080);

//var teachersQueue = []; // [socket, room or empty or nil, app]
//var learnersQueue = []; // [socket, room, app]
//var teachers = {};      // {room -> socket}
//var learners = {};      // {room -> socket}

var apps = {}; // {appName -> App}

function App(name) {
  this.name = name;
  this.reset();
};

App.prototype.reset = function() {
  this.teachersQueue = [];  // [socket, room or empty or nil]
  this.learnersQueue = [];  // [socket, room, app]
  this.teachers = {};       // {room -> socket}
  this.learners = {};       // {room -> socket}
};

function resetAll() {
  for (var a in apps) {
    apps[a].reset();
  }
};

function ensureApp(appName) {
  if (!apps[appName]) {
    apps[appName] = new App(appName);
  }
  return apps[appName];
};

function deleteRoom(room) {
  for (var a in apps) {
    delete apps[a].remove(room);
  }
};

App.prototype.remove = function(room) {
  delete this.learners[room];
  delete this.teachers[room];
};

App.prototype.dump = function() {
  console.log('dump: ' + this.name);
  console.log('  learners:');
  console.log(this.learners);
  console.log('  teachers:');
  console.log(this.teachers);
  console.log('  learnersQueue:');
  console.log(this.learnersQueue);
  console.log('  teachersQueue:');
  console.log(this.teachersQueue);
};

App.prototype.addLearner = function(socket, room) {
  if (this.learners[room] && this.learners[room].connected) {
    return 'in use';
  }
  this.learners[room] = socket;
  this.learnersQueue.push([socket, room]);
  return 'added';
};

App.prototype.addTeacher = function(socket, room) {
  if (this.teachers[room] && this.teachers[room].connected) {
    return 'in use';
  }
  this.teachersQueue.push([socket, room]);
  this.teachers[room] = socket;
  return 'added';
};
  
App.prototype.isLearner = function(socket) {
  for (var k in this.learners) {
    if (this.learners[k] === socket) {
      return true;
    }
  }
  return false;
};

App.prototype.findMatchFor = function(pair, queue) {
  var room = pair[1];
  console.log('findMatch:' + room, queue);
  while (true) {
    if (queue.length === 0) {
      return null;
    }
    var elem = queue[0];
    if (elem[0].connected && (elem[1] === room || !elem[1] || !room)) {
      return elem;
    } else {
      queue.shift();
    }
  }
};

App.prototype.maybeStartFor = function(role, socket, room) {
  var learner, teacher;
  console.log('maybeStart', role, socket.id, room);
  if (role == 'learner') {
    learner = [socket, room];
    teacher = this.findMatchFor(learner, this.teachersQueue);
    if (teacher) {
      console.log('t: ' + teacher[1]);
      this.teachersQueue.shift();
      socket.join(room);
      teacher[0].join(room);
      this.teachers[room] = teacher[0];
      this.learners[room] = learner[0];
      io.sockets.in(room).emit('ready', room);
    } else {
      var result = this.addLearner(socket, room);
      if (result === 'full') {
       socket.emit('full', room);
      }
      //console.log('after add learner');
      //this.dump();
    }
  } else {
    teacher = [socket, room];
    learner = this.findMatchFor(teacher, this.learnersQueue);
    if (learner) {
      console.log('l: ' + learner[1]);
      this.learnersQueue.shift();
      room = learner[1];
      socket.join(room);
      learner[0].join(room);
      this.learners[room] = learner[0];
      this.teachers[room] = teacher[0];
      io.sockets.in(room).emit('ready', room);
    } else {
      this.addTeacher(socket, room);
    }
  }
};

function roomFromSocket(socket) {
  for (var a in apps) {
    //console.log('a', a);
    //apps[a].dump();
    var learners = apps[a].learners;
    var teachers = apps[a].teachers;
    for (var k in learners) {
      if (learners[k] === socket) {
        return [a, k];
      }
    }
    for (var k in teachers) {
      if (teachers[k] === socket) {
        return [a, k];
      }
    }
  }
  return null;
};

var io = socketIO.listen(server);
io.sockets.on('connection', function(socket) {
  console.log('connected: ' + socket.id);

  // convenience function to log server messages on the client
  function log() {
    var array = ['Message from server:'];
    array.push.apply(array, arguments);
    socket.emit('log', array);
  };

  socket.on('message', function(message, room) {
    log('Client said: ', message + ' in ' + room);
    socket.in(room).emit('message', message);
//    // for a real app, would be room-only (not broadcast)
//    socket.broadcast.emit('message', message);
  });

  socket.on('newTeacher', function(room, appName) {
    log('a new teacher is looking for a room: ' + room + ' for ' + appName);
    var app = ensureApp(appName);
    app.maybeStartFor('teacher', socket, room);
  });

  socket.on('newLearner', function (room, appName) {
    log('a new learner with a room: ' + room + ' for ' + appName);
    socket.emit('created', room, socket.id);
    var app = ensureApp(appName);
    app.maybeStartFor('learner', socket, room);
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
    console.log('disconnected:' + socket.id);
    var appAndRoom = roomFromSocket(socket);
    console.log('app and room: ' + appAndRoom);
    if (appAndRoom) {
      var app = appAndRoom[0];
      var room = appAndRoom[1];
      apps[app].remove(room);
      if (room) {
        io.sockets.in(room).emit('peerDisconnected', room);
      }
    }
  });

  socket.on('renegotiate', function(room) {
    console.log('renegotiation in room: ' + room);
    io.sockets.in(room).emit('readyAgain', room);
  });

  socket.on('reset', function() {
    console.log('reset queues');
    resetAll();
  });

  socket.on('dump', function(appName) {
    if (appName && apps[appName]) {
      apps[appName].dump();
    };
    if (!appName) {
      for (var a in apps) {
        apps[a].dump();
      }
    }
   });
});
