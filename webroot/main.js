/* globals Croquet */
/* eslint-disable max-classes-per-file */

let configuration = {
    "iceServers": [{
        "url": 'stun:stun.l.google.com:19302'
    }]
};

/*
let offerOptions = {
    offerToReceiveAudio: 1,
    offerToReceiveVideo: 1
};
*/

let eventTypes = {keydown: 0, keyup: 1, keypress: 2, mousedown: 3, mouseup: 4, mousemove: 5};
let dataTypes = {image: 0, event: 1, canvasSize: 2};

let isFireFox = false;

class Media {
    constructor() {
        this.stream = null;
        this.recorder = null;
        this.writer = null;
        this.writerReady = true;
        this.chunks = [];
        this.fileName = '';
    }
}

class RTCModel extends Croquet.Model {
    init(options, persist) {
        super.init(options, persist);
        this.users = {};
        this.learner = null;

        this.subscribe(this.sessionId, "view-join", this.viewJoin);
        this.subscribe(this.sessionId, "view-exit", this.viewExit);

        this.subscribe(this.id, "message", this.message);
    }

    viewJoin(viewId) {
        this.users[viewId] = true;
        if (Object.keys(this.users).length === 1) {
            if (!this.learner) {
                this.learner = viewId;
            }
        }
        this.publish(this.id, "user-join", viewId);
    }

    viewExit(viewId) {
        delete this.users[viewId];
        this.publish(this.id, "user-exit", viewId);
    }

    message(data) {
        this.publish(this.id, data.name, data);
    }
}

RTCModel.register("RTCModel");

class RTCView extends Croquet.View {
    constructor(model) {
        super(model);
        this.model = model;

        this.subscribe(this.model.id, "user-join", this.userJoin.bind(this));
        this.subscribe(this.model.id, "user-exit", this.userExit.bind(this));
        this.subscribe(this.viewId, "synced", this.synced.bind(this));

        this.subscribe(this.model.id, "video-offer", this.onReceiveVideoOffer.bind(this));
        this.subscribe(this.model.id, "video-answer", this.onReceiveVideoAnswer.bind(this));
        this.subscribe(this.model.id, "new-ice-candidate", this.onReceiveNewIceCandidate.bind(this));
        this.subscribe(this.model.id, "stream-received", this.onStreamAcknowleded.bind(this));

        this.subscribe(this.model.id, "canvas-size", this.onReceiveCanvasSize.bind(this));

        this.peers = {}; // {viewId: PeerConnection}
        this.dataChannels = {}; // {viewId: DataChannel}

        this.remoteAudio = {};
        this.remoteEvents = {};
        this.remoteCursors = {};

        this.canvas = new Media();
        this.localAudio = new Media();
        this.localEvents = new Media();

        this.videoCanvas = null;
        this.lastCanvasWidth = -1;
        this.lastCanvasHeight = -1;

        window.viewId = this.viewId;
    }

    synced(flag) {
        console.log("synced", flag);
        if (flag) {
            this.startUp();
        }
    }

    startUp() {
        if (this.isLearner()) {
            this.setupLearner();
        } else {
            this.setupTeacher();
        }
    }

    userJoin(viewId) {
        console.log("view join", viewId);
        if (this.model.learner === this.viewId) {
            this.setupLearner();
            if (viewId !== this.viewId) {
                this.startNegotiation(viewId);
            }
        } else {
            this.setupTeacher();
        }
    }

    userExit(viewId) {
        this.removeMedia(viewId);
        if (viewId === this.model.learner) {
            if (this.videoCanvas) {
                this.videoCanvas.srcObject = null;
                this.videoCavnas = null;
                this.videoCanvas.remove();
            }
            let note = document.createElement("div");
            note.id = "note";
            note.textContent = "The learner left the session";
            document.body.appendChild(note);
        }
        console.log("exit: ", viewId);
    }

    isLearner() {
        return this.model.learner === this.viewId;
    }

    setupLearner() {
        if (this.sqCanvas) {return;}

        window.runSnap();
        this.sqCanvas = document.getElementById(window.canvasName);
        window.addEventListener("resize", () => this.windowResize());
    }

    setupTeacher() {
        if (this.videoCanvas) {return;}
        this.videoCanvas = document.createElement("video");
        this.videoCanvas.classList.add("pixelated");
        this.videoCanvas.id = "videoCanvas";
        this.videoCanvas.autoplay = true;
        this.notPlayed = true;

        this.startButton = document.createElement("div");
        this.startButton.textContent = "START";
        this.startButton.id = "startButton";

        this.startButton.addEventListener("click", (evt) => this.startButtonPressed(evt));

        document.body.appendChild(this.videoCanvas);
        document.body.appendChild(this.startButton);

        document.addEventListener('keydown', (evt) => this.sendEvent(evt), false);
        document.addEventListener('keypress', (evt) => this.sendEvent(evt), false);
        document.addEventListener('keyup', (evt) => this.sendEvent(evt), false);
        this.videoCanvas.addEventListener('mousedown', (evt) => this.sendEvent(evt), false);
        this.videoCanvas.addEventListener('mousemove', (evt) => this.sendEvent(evt), false);
        this.videoCanvas.addEventListener('mouseup', (evt) => this.sendEvent(evt), false);
    }

    startButtonPressed(_evt) {
        if (this.notPlayed) {
            this.notPlayed = false;
            this.videoCanvas.play();
            this.publish(this.model.id, "message", {name: "refresh-video", to: this.model.learner});
        }
        this.startButton.remove();
    }

    windowResize() {
        if (this.isLearner() && this.sqCanvas) {
            this.publish(this.model.id, "message", {
                name: "canvas-size",
                width: this.sqCanvas.width,
                height: this.sqCanvas.height,
            });
        }
    }

    ensureMedia(remoteViewId) {
        if (!this.remoteAudio[remoteViewId]) {
            this.remoteAudio[remoteViewId] = new Media();
        }
        if (!this.remoteEvents[remoteViewId]) {
            this.remoteEvents[remoteViewId] = new Media();
        }
        if (!this.remoteCursors[remoteViewId]) {
            let c;
            if (window.wantsDOMCursor) {
                c = document.createElement("div");
                c.id = 'cursor-' + remoteViewId;
                c.innerHTML = 'X';
                c.style.position = 'absolute';
                c.style.pointerEvents = 'none';
                document.body.appendChild(c);
                // videoCanvas.style.cursor = 'none';
            } else {
                c = {id: 'cursor-' + remoteViewId};
            }
            this.remoteCursors[remoteViewId] = c;
        }
    }

    removeMedia(remoteViewId) {
        delete this.remoteAudio[remoteViewId];
        delete this.remoteEvents[remoteViewId];

        if (this.remoteCursors[remoteViewId]) {
            if (this.remoteCursors[remoteViewId].remove) {
                this.remoteCursors[remoteViewId].remove();
            }
            delete this.remoteCursors[remoteViewId];
        }
        if (this.isLearner()) {
            window.sqStartUp(this);
        }
    }

    createPeerConnection(remoteViewId) {
        let isLearner = this.isLearner();
        console.log('Creating Peer connection as initiator', remoteViewId);
        let peerConn = new RTCPeerConnection(configuration);
        peerConn.onicecandidate = (event) => {
            console.log('icecandidate event:', event);
            if (event.candidate) {
                this.publish(this.model.id, "message", {
                    name: "new-ice-candidate",
                    message: {
                        type: event.candidate.type,
                        sdpMLineIndex: event.candidate.sdpMLineIndex,
                        sdpMid: event.candidate.sdpMid,
                        candidate: event.candidate.candidate,
                        usernameFragment: event.candidate.usernameFragment,
                    },
                    from: this.viewId,
                    to: remoteViewId
                });
            } else {
                console.log('End of candidates.');
            }
        };

        if (!isLearner) {
            console.log("adding ondatachannel");
            peerConn.ondatachannel = (event) => {
                console.log("on datachannel");
                let dataChannel = event.channel;
                dataChannel.onopen = () => {console.log("Channel opened");};

                dataChannel.onmessage = isFireFox
                    ? this.receiveDataFirefoxFactory(remoteViewId)
                    : this.receiveDataChromeFactory(remoteViewId);
                this.dataChannels[remoteViewId] = dataChannel;
            };
        }

        peerConn.onaddstream = (event) => {
            console.log('Remote stream added.', event);
            let tracks = event.stream.getTracks();
            if (tracks.length > 0 && tracks[0].kind === "video") {
                this.videoCanvas.srcObject = event.stream;
                this.publish(this.model.id, "message", {name: "stream-received", from: this.viewId, to: remoteViewId});
                //this.videoCanvas.play();
            } else if (tracks.length > 0 && tracks[0].kind === "audio") {
                this.remoteAudio[remoteViewId].stream = event.stream;
                let audio = document.createElement("audio");
                audio.autoplay = true;
                audio.id = 'audio-' + remoteViewId;
                document.body.appendChild(audio);
                audio.srcObject = event.stream;
            }
        };
        return peerConn;
    }

    startNegotiation(remoteViewId) {
        // this is the initiator.
        // When a second and other view joins, the first one calls this
        if (this.peers[remoteViewId]) {return;}
        let peerConn = this.createPeerConnection(remoteViewId);
        this.peers[remoteViewId] = peerConn;

        if (this.isLearner()) {
            this.localStream = this.sqCanvas.captureStream();
            let track = this.localStream.getVideoTracks()[0];
            if (!track) {throw new Error("no canvas video track");}

            this.setupChannels(remoteViewId);
            peerConn.addTrack(track, this.localStream);
            peerConn.createOffer().then((offer) => {
                peerConn.setLocalDescription(offer).then(() => {
                    console.log('sending local desc:', peerConn.localDescription);
                    this.publish(this.model.id, "message", {name: "video-offer", message: {sdp: offer.sdp, type: offer.type}, from: this.viewId, to: remoteViewId});
                }).catch((err) => {
                    logError(err);
                });
            });
        }
    }

    onReceiveVideoOffer(data) {
        let {from, to, message} = data;
        if (to !== this.viewId) {return;}

        let peerConn = this.peers[from];

        if (!peerConn) {
            peerConn = this.createPeerConnection(from);
            this.peers[from] = peerConn;
        }

        let answer;

        peerConn.setRemoteDescription(message).then(() => {
            console.log('remote description set:', message);
        }).then(() => {
            return peerConn.createAnswer();
        }).then((a) => {
            answer = a;
            return peerConn.setLocalDescription(answer);
        }).then(() => {
            this.publish(this.model.id, "message", {
                name: "video-answer",
                message: {type: answer.type, sdp: answer.sdp}, from: this.viewId, to: from});
        });
    }

    onReceiveVideoAnswer(data) {
        let {from, to, message} = data;

        if (to !== this.viewId) {return;}
        console.log("Got answer");
        let peerConn = this.peers[from];
        peerConn.setRemoteDescription(message);
    }

    onReceiveNewIceCandidate(data) {
        let {from, to, message} = data;
        if (to !== this.viewId) {return;}
        console.log("Got candidate");
        let peerConn = this.peers[from];

        peerConn.addIceCandidate(new RTCIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex,
            usernameFragment: message.usernameFragment
        }));
    }

    onStreamAcknowleded(data) {
        let {from, to} = data;
        if (to !== this.viewId) {return;}
        this.ensureMedia(from);
        if (this.isLearner() && this.sqCanvas) {
            this.windowResize();
            window.sqStartUp(this);
        }

        window.world.worldCanvas.getContext("2d").fillRect(0, 0, 1, 1);
    }

    onReceiveCanvasSize(data) {
        let {width, height} = data;
        if (this.isLearner()) {return;}

        this.lastCanvasWidth = width;
        this.lastCanvasHeight = height;
    }

    setupChannels(remoteViewId) {
        let peerConn = this.peers[remoteViewId];
        if (this.isLearner()) {
            console.log('Creating Data Channel for ' + remoteViewId);
            let dataChannel = peerConn.createDataChannel('channel' + remoteViewId);
            dataChannel.onopen = () => {console.log("Channel opened");};
            dataChannel.onmessage = isFireFox
                ? this.receiveDataFirefoxFactory(remoteViewId)
                : this.receiveDataChromeFactory(remoteViewId);
            this.dataChannels[remoteViewId] = dataChannel;
        }
    }

    receiveDataChromeFactory(remoteViewId) {
        let type, buf, count;
        // the next values;
        return (event) => {
            if (typeof event.data === "string") {
                let payload = parseInt(event.data, 10);
                type = payload >> 24;
                if (type === dataTypes.event) {
                    //console.log('expecting an event.');
                }
                return;
            }

            if (type === dataTypes.event) {
                // assuming this 20 bytes data won't get split during transimission
                buf = new Uint32Array(event.data);
                this.receiveEvent(buf, remoteViewId);
            } else if (type === dataTypes.image) {
                var data = new Uint8ClampedArray(event.data);
                buf.set(data, count);
                count += data.byteLength;
                console.log('count: ' + count);

                if (count === buf.byteLength) {
                    // we're done: all data chunks have been received
                    console.log('Done. Rendering image.');
                    this.receiveImage(buf);
                }
            } else if (type === dataTypes.canvasSize) {
                // assuming this 8 bytes data won't get split during transimission
                buf = new Uint32Array(event.data);
                this.receiveCanvasSize(buf);
            }
        };
    }

    receiveDataFirefoxFactory(id) {
        return (event) => {
            let buf = new Uint32Array(event.data);
            console.log('Done. Rendering event.');
            this.receiveEvent(buf, id);
        };
    }

    receiveEvent(buf, id) {
        let left = 0, top = 0, scale = 1, offX = 0, offY = 0;
        let remoteCursor = this.remoteCursors[id];
        if (!remoteCursor) {return;}
        if (this.videoCanvas) {
            let rect = this.videoCanvas.getBoundingClientRect();
            left = rect.left;
            top = rect.top;
            scale = rect.width / this.lastCanvasWidth;
        }

        if (window.wantsDOMCursor) {
            offX = remoteCursor.getBoundingClientRect().width / 2;
            offY = remoteCursor.getBoundingClientRect().height / 2;

            let posX = (buf[1] * scale) + left - offX;
            let posY = (buf[2] * scale) + top - offY;

            remoteCursor.style.left = `${posX}px`;
            remoteCursor.style.top = `${posY}px`;
            // transform
        }

        if (remoteCursor.sqRcvEvt) {
            remoteCursor.sqRcvEvt(buf);
        }
    }

    sendEvent(evt) {
        if (!this.videoCanvas) {return;}
        let buf = this.encodeEvent(evt);
        if (!buf) {return;}
        for (let k in this.dataChannels) {
            let dataChannel = this.dataChannels[k];
            try {
                dataChannel.send(dataTypes.event << 24 | buf.byteLength);
                dataChannel.send(buf);
            } catch (e) {
                console.log('send failed', e, ' to ', k);
            }
        }
    }

    encodeEvent(evt) {
        const p = {width: this.lastCanvasWidth, height: this.lastCanvasHeight};
        if (p.width <= 0 || p.height <= 0) {
            // nothing to share anyway
            return null;
        }

        const pRatio = p.height / p.width;
        const myW = window.innerWidth;
        const myH = window.innerHeight;
        if (myW === 0 || myH === 0) {
            // nothing to do
            return null;
        }
        const myRatio = myH / myW;

        let scale;
        let offsetX;
        let offsetY;

        if (pRatio < myRatio) {
            // top and bottom black area
            scale = myW / p.width;
            offsetX = 0;
            offsetY = (myH - (p.height * scale)) / 2;
        } else {
            // left and right black area
            scale = myH / p.height;
            offsetX = (myW - (p.width * scale)) / 2;
            offsetY = 0;
        }

        if (!this.isLearner() && this.videoCanvas) {
            return this.snapEncodeEvent(evt, (evt.offsetX - offsetX) / scale, (evt.offsetY- offsetY) / scale);
        }
        return null;
    }

    snapEncodeEvent(evt, posX, posY) {
        let mod;
        let v = new Uint32Array(7);  // [type, posX, posY, keyCode, modifiers, buttons, button]
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
            if (evt.metaKey) {mod |= 1;}
            if (evt.altKey) {mod |= 2;}
            if (evt.ctrlKey) {mod |= 4;}
            if (evt.shiftKey) {mod |= 8;}
            v[4] = mod;
            break;
        default:
        }
        return v.buffer;
    }

    sendCanvasSize() {
        let nowW = this.sqCanvas.width;
        let nowH = this.sqCanvas.height;
        if (nowW === this.lastCanvasWidth
            && nowH === this.lastCanvasHeight) {
            return;
        }
        for (let k in this.dataChannels) {
            let dataChannel = this.dataChannels[k];
            let buf = new Uint32Array(2);
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
        this.lastCanvasWidth = nowW;
        this.lastCanvasHeight = nowH;
    }
}

function logError(err) {
  console.log(err.toString(), err);
}

function join() {
    Croquet.Session.join({
        appId: "io.croquet.vnc",
        name: Croquet.App.autoSession('q'),
        password: "secret",
        model: RTCModel,
        view: RTCView,
        tps: 0,
        autoSleep: false
    }).then(session => {
        window.session = session;
    });
}

window.onload = () => {
    join();
};

//startRecordingMedia(mergedAudio);
