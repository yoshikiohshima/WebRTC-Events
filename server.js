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

var apps = {}; // {appName -> App}

var sockets = {}; // {id -> socket}

function findSocket(id) {
  var sock = sockets[id];
  if (sock && sock.connected) {return sock;}
  return null;
};

function Session(room, appName, learner) {
  this.room = room;
  this.app = appName;
  this.learner = learner;  // Participant
  this.teachers = [];      // [participant]
};

Session.prototype.start = function() {
  var room = this.room;
  var ary = [];
  this.learner.socket.join(room);
  ary.push(this.learner.socket.id);
  for (var i = 0; i < this.teachers.length; i++) {
    this.teachers[i].socket.join(room);
    ary.push(this.teachers[i].socket.id);
  };
  
  io.sockets.in(room).emit('ready', room, ary);
};

Session.prototype.addTeacher = function(teacher) {
  this.teachers.push(teacher);
}

function Participant(socket, room, role) {
  this.room = room;      // string or null
  this.socket = socket;  // socket
  this.role = role;      // learner or teacher
};

Participant.prototype.connected = function() {
  return this.socket.connected;
};

function App(name) {
  this.name = name;
  this.reset();
};

App.prototype.reset = function() {
  this.sessions = {}        // {room -> Session}
  this.teachersQueue = [];  // [Participant]
  this.learnersQueue = [];  // [Participant]
  
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
  delete this.sessions[room];
};

App.prototype.dump = function() {
  console.log('dump: ' + this.name);
  console.log('  sessions:');
  console.log(this.sessions);
  console.log('  learnersQueue:');
  console.log(this.learnersQueue);
  console.log('  teachersQueue:');
  console.log(this.teachersQueue);
};

App.prototype.addLearner = function(learner) {
  this.learnersQueue.push(learner);
};

App.prototype.addTeacher = function(teacher) {
  this.teachersQueue.push(teacher);
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

App.prototype.isNewRoom = function(room) {
  return !(this.sessions[room] && this.sessions[room].learner.connected());
};

App.prototype.findAvailableTeacherFor = function(learner) {
  var queue = this.teachersQueue;
  var room = learner.room;
  console.log('findAvaiableTeacher:' + room, queue);
  var i = 0;
  while (true) {
    if (i >= queue.length) {
      return null;
    }
    var teacher = queue[i];
    if (teacher.connected()) {
      if (teacher.room === room || !teacher.room);
      return queue.splice(i, 1)[0];
    } else {
      i = i + 1;
    }
  }
};

App.prototype.findSessionFor = function(teacher) {
  var queue = this.learnersQueue;
  var room = teacher.room;
  console.log('findSession:' + room, queue);
  if (room) {
    if (this.sessions[room]) {
      console.log("found session:", teacher);
      return this.sessions[room];
    };
    return null;
  }

  while (true) {
    if (queue.length === 0) {
      return null;
    }
    var elem = queue[0];
    if (elem.connected()) {
      var learner = queue.shift();
      return this.sessions[learner.room];
    } else {
      queue.shift();
    }
  }
};

function learnerSessionFromSocket(socket) {
  for (var a in apps) {
    for (var k in apps[a].sessions) {
      var session = apps[a].sessions[k];
      if (session.learner.socket === socket) {
        return session;
      }
    }
  }
  return null;
};

function removeTeacherFromSocket(socket) {
  for (var a in apps) {
    for (var k in apps[a].sessions) {
      var session = apps[a].sessions[k];
      for (var i = 0; i < session.teachers.length; i++) {
        if (session.teachers[i].socket === socket) {
          session.teachers.splice(i, 1);
          return session;
        }
      }
    }
  }
  return null;
};

var io = socketIO.listen(server);
io.sockets.on('connection', function(socket) {
  sockets[socket.id] = socket;
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

  socket.on('uniMessage', function(message, room, from, to) {
    var toSocket = findSocket(to);
    if (toSocket) {
      toSocket.emit('uniMessage', message, room, from, to);
    }
//    // for a real app, would be room-only (not broadcast)
//    socket.broadcast.emit('message', message);
  });

  socket.on('newTeacher', function(room, appName) {
    var learner, teacher;
    log('a new teacher is looking for a room: ' + room + ' for ' + appName + ' socket id ' + socket.id);
    var app = ensureApp(appName);
    teacher = new Participant(socket, room, 'teacher');
    var session = app.findSessionFor(teacher);
    socket.emit('id', socket.id);
    if (session) {
      console.log('session: ' + session.room);
      session.addTeacher(teacher);
      session.start();
    } else {
      app.addTeacher(teacher);
    }
  });

  socket.on('newLearner', function (room, appName) {
    var learner, teacher, session;
    log('a new learner with a room: ' + room + ' for ' + appName);
    console.log('a new learner with a room: ' + room + ' for ' + appName);
    var app = ensureApp(appName);
    if (app.isNewRoom(room)) {
      socket.emit('id', socket.id, room);
      learner = new Participant(socket, room, 'learner');
      session = new Session(room, appName, learner);
      app.sessions[room] = session
      teacher = app.findAvailableTeacherFor(learner);
      if (teacher) {
        console.log('t: ' + teacher.room);
        session.addTeacher(teacher);
        session.start();
      } else {
        app.addLearner(learner);
      }
    } else {
      socket.emit('occupied', room);
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
    console.log('disconnected:' + socket.id);
    var session = learnerSessionFromSocket(socket);
    console.log('l session: ', session);
    delete sockets[socket.id];
    if (session) {
      var app = session.app;
      var room = session.room;
      if (room) {
        io.sockets.in(room).emit('roomClosed', room);
      }
      apps[app].remove(room);
      return;
    }
    session = removeTeacherFromSocket(socket);
    console.log('t session: ', session);
    if (session) {
      var room = session.room;
      if (session.room === room) {
        console.log('emit teacherDisconnected', room, session);
        //session.learner.socket.emit('teacherDisconnected', room, socket.id);
        io.sockets.in(room).emit('teacherDisconnected', room, socket.id);
      }
      return;
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
