'use strict';

var os = require('os');
var fs = require('fs');
var nodeStatic = require('node-static');
var fileServer = new(nodeStatic.Server)('webroot');
var socketIO = require('socket.io');

if (process.argv.length > 2) {
  var http = require('https');
  var serverOptions = {
    key: fs.readFileSync('privkey1.pem'),
    cert: fs.readFileSync('cert1.pem')
  };
  var server = http.createServer(serverOptions, function(req, res) {
    fileServer.serve(req, res);
  });
} else {
  var http = require('http');
  var server = http.createServer(function(req, res) {
    fileServer.serve(req, res);
  });
}

var defaultAppName = 'Etoys';

server.listen(8080);

function App(name) {
  this.name = name;
  this.teachersQueue = [];
  this.learnersQueue = [];
  this.learners = {}; // room -> socket;
  this.teachers = {}; // room -> socket;
};

var apps = {}; // name -> App

//var teachersQueue = [];
//var learnersQueue = [];
//var learners = {}; // room -> socket;
//var teachers = {}; // room -> socket;

function addLearner(app, socket, room) {
  if (app.learners[room] && app.learners[room].connected) {
    return 'in use';
  }
  app.learnersQueue.push([socket, room]);
  app.learners[room] = socket;
  return 'added';
};

//function removeLearner(app, socket) {
//  for (var k in app.learners) {
//    if (app.learners[k] === socket) {
//      delete app.learners[k];
//    }
//  }
//  return false;
//};

//function isLearner(app, socket) {
//  for (var k in app.learners) {
//    if (app.learners[k] === socket) {
//      return true;
//    }
//  }
//  return false;
//};

function appAndRoomFromSocket(socket) {
  for (var appName in apps) {
    var app = apps[appName];
    for (var k in app.learners) {
      if (app.learners[k] === socket) {
        return [app, k];
      }
    }
    for (var k in app.teachers) {
      if (app.teachers[k] === socket) {
        return [app, k];
      }
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
    console.log('elem: ' + elem[0].connected);
    if (elem[0].connected && (elem[1] === room || !elem[1])) {
      return elem;
    } else {
      queue.shift();
    }
  }
};

function maybeStart(app) {
  console.log("maybeStart: " + app.name);
  var learner = findFirstAvailableFrom(app.learnersQueue);
  if (learner) {
    console.log('l: ' + learner[1]);
    var teacher = findMatchFor(learner, app.teachersQueue);
  }
  if (teacher && learner) {
    console.log('t: ' + teacher[1]);
    app.teachersQueue.shift();
    app.learnersQueue.shift();
    var socket = learner[0];
    var room = learner[1];
    socket.join(room);
    teacher[0].join(room);
    app.teachers[room] = teacher[0];
    io.sockets.in(room).emit('ready', room);
  }
  console.log('end of maybeStart(' + app.name + ')');
}

var io = socketIO.listen(server);
io.sockets.on('connection', function(socket) {
  // convenience function to log server messages on the client
  function log() {
    var array = ['Message from server:'];
    array.push.apply(array, arguments);
    socket.emit('log', array);
  }

  socket.on('message', function(message, room) {
    log('Client said: ', message, room);
    io.sockets.in(room).emit('message', message);
//    // for a real app, would be room-only (not broadcast)
//    socket.broadcast.emit('message', message);
  });

  socket.on('newTeacher', function(room, appName) {
    log('a new teacher is looking for an app: ' + appName + ' in a room: ' + room);
    if (!appName) {appName = defaultAppName;}
    if (!apps[appName]) {
      apps[appName] = new App(appName);
    }
    var app = apps[appName];
    app.teachersQueue.push([socket, room]);
    maybeStart(app);
  });

  socket.on('newLearner', function (room, appName) {
    log('a new learner for an app: ' + appName + ' with a room: ' + room);
    socket.emit('created', room, socket.id);
    if (!appName) {appName = defaultAppName;}
    if (!apps[appName]) {
      apps[appName] = new App(appName);
    }
    var app = apps[appName];
    var result = addLearner(app, socket, room);
    if (result === 'added') {
      maybeStart(app);
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
    var appAndRoom = appAndRoomFromSocket(socket);
    console.log('room: ' + appAndRoom);
    if (appAndRoom) {
      var app = appAndRoom[0];
      var room = appAndRoom[1];
      delete app.learners[room];
      io.sockets.in(room).emit('peerDisconnected', room);
    }
  });

  socket.on('renegotiate', function(room) {
    // assuming that room is unique accross apps?
    console.log('renegotiation in room: ' + room);
    io.sockets.in(room).emit('readyAgain', room);
  });

  socket.on('reset', function(appName) {
    console.log('reset queues');
    var app = apps[appName];
    if (app) {
      app.teachersQueue = [];
      app.learnersQueue = [];
      app.learners = {};
    }
  });

  socket.on('dump', function(appName) {
    console.log('dump');
    if (appName) {
      var app = apps[appName];
      if (app) {
        console.log('app: ' + appName);
        console.log(app.learners);
        console.log(app.learnersQueue);
        console.log(app.teachersQueue);
      }
    } else {
      for (var k in apps) {
        var app = apps[k];
        if (app) {
          console.log('app: ' + k);
          console.log(app.learners);
          console.log(app.learnersQueue);
          console.log(app.teachersQueue);
        }
      }
    }
  });
});
