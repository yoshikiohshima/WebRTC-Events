/* global Croquet, AgoraRTC */
/* eslint-disable max-classes-per-file */

class RTCModel extends Croquet.Model {
    init(options, persist) {
        super.init(options, persist);
        this.users = {};
        this.learner = null;
        this.isSharing = false;

        this.presenterExtent = {width: 0, height: 0};

        this.subscribe(this.sessionId, "view-join", this.onViewJoin);
        this.subscribe(this.sessionId, "view-exit", this.onViewExit);

        this.subscribe(this.id, "share-screen", this.onShareScreen);
        this.subscribe(this.id, "stop-sharing-screen", this.onStopSharingScreen);

        this.subscribe(this.id, "presenter-screen-extent", this.onPresenterScreenExtent);

        this.subscribe(this.id, "refresh-video", this.onRefreshVideo);
        this.subscribe(this.id, "dom-event", this.onDomEvent);

        this.subscribe(this.id, "learner-left", this.onLearnerLeft);
    }

    onViewJoin(viewId) {
        this.users[viewId] = true;
        if (Object.keys(this.users).length === 1) {
            if (!this.learner) {
                this.learner = viewId;
            }
        }
        this.publish(this.id, "user-join", viewId);
    }

    onViewExit(viewId) {
        delete this.users[viewId];
        this.publish(this.id, "user-exit", viewId);
    }

    onShareScreen(viewId) {
        if (this.learner !== viewId) {return;}
        this.isSharing = true;
        this.publish(this.id, "sharing-screen", viewId);
    }

    onStopSharingScreen(viewId) {
        if (this.learner === viewId) {
            this.isSharing = false;
            this.publish(this.id, "stopped-sharing-screen", viewId);
        }
    }

    onPresenterScreenExtent(extent) {
        // {width, height, possibly offset in screenX and screenY}
        this.presenterExtent = extent;
    }

    onDomEvent(data) {
        this.publish(this.id, "remote-dom-event", data);
    }

    onRefreshVideo(viewId) {
        this.publish(this.id, "refresh-request", viewId);
    }

    onLearnerLeft() {
        this.learnerLeft = true;
    }
}

RTCModel.register("RTCModel");

class RTCView extends Croquet.View {
    constructor(model) {
        super(model);
        this.model = model;

        this.appID = window.key;
        this.client = AgoraRTC.createClient({mode: "rtc", codec: "vp8"});

        this.subscribe(this.model.id, "user-join", this.userJoin.bind(this));
        this.subscribe(this.model.id, "user-exit", this.userExit.bind(this));
        this.subscribe(this.viewId, "synced", this.synced.bind(this));

        this.subscribe(this.model.id, "sharing-screen", this.onSharingScreen.bind(this));
        this.subscribe(this.model.id, "stopped-sharing-screen", this.onStoppedSharingScreen.bind(this));

        this.subscribe(this.model.id, "remote-dom-event", this.onRemoteDomEvent);
        this.subscribe(this.model.id, "refresh-request", this.onRefreshRequested);

        Croquet.App.autoSession("q").then((sessionId) => {
            this.client.join(this.appID, sessionId, null).then(uid => {
                this.uid = uid;
                this.client.on("user-published", this.onUserPublished.bind(this));
                this.client.on("user-unpublished", this.onUserUnpublished.bind(this));
                if (this.model.isSomeoneSharing) {
                    this.onSharingScreen();
                } else {
                    this.refreshUIState();
                }
            });
        });

        this.remoteCursors = {};
        this.videoHolder = null;

        window.view = this;
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
                this.shareScreen();
                this.ensureRemoteCursor(viewId);
                window.sqStartUp(this);
                this.windowResize();
            }
        } else {
            this.setupTeacher();
        }
    }

    userExit(viewId) {
        if (this.isLearner()) {
            this.removeRemoteCursor(viewId);
            window.sqStartUp(this);
            if (Object.keys(this.model.users).length === 1) {
                this.stopSharingScreen();
            }
        }

        if (viewId === this.model.learner) {
            if (this.videoHolder) {
                this.videoHolder.innerHTML = "";
            }
            this.showNote();
            this.publish(this.model.id, "learner-left");
        }
    }

    showNote() {
        this.removeStartButton();
        let note = document.createElement("div");
        note.id = "note";
        note.textContent = "The learner left the session";
        document.body.appendChild(note);
    }

    removeStartButton() {
        if (this.startButton) {
            this.startButton.remove();
            this.startButton = null;
        }
    }

    ensureRemoteCursor(remoteViewId) {
        if (!this.remoteCursors[remoteViewId]) {
            let c = {id: "cursor-" + remoteViewId};
            this.remoteCursors[remoteViewId] = c;
        }
    }

    removeRemoteCursor(remoteViewId) {
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

    shareScreen() {
        if (!this.uid) {return;}
        if (this.isSharing) {return;}

        this.world = document.getElementById("world");
        if (!this.world || this.world.constructor.name !== "HTMLCanvasElement") {
            console.log("does not seem to be a Snap project");
            return;
        }

        this.stream = this.world.captureStream();
        this.mediaTrack = this.stream.getVideoTracks()[0];

        this.publish(this.model.id, "share-screen", this.viewId);
        this.publishScreenExtent();

        const track = AgoraRTC.createCustomVideoTrack({
            mediaStreamTrack: this.mediaTrack,
            optimizationMoe: "detail"
        });

        this.videoTrack = track;
        this.client.publish(track).then(() => {
            this.isSharing = true;
            if (this.flipper) {
                clearInterval(this.flipper);
            }
            this.flipper = setInterval(() => this.flipAPixel(), 2000);
        }).catch(err => {
            console.log(err);
            console.log(`Unable to share screen. Make sure you've allowed this page to see your screen. On Mac, you can check if you've given this browser access to the screen under "Settings > Security & Privacy > Screen Recording`);
            this.closeTracks();
            this.refreshUIState();
        });
    }

    stopSharingScreen() {
        if (this.isLearner()) {
            this.closeTracks();
            this.publish(this.model.id, "stop-sharing-screen", this.viewId);
        }
    }

    isLearner() {
        return this.model.learner === this.viewId;
    }

    setupLearner() {
        if (this.sqCanvas) {return;}

        window.eventIsObject = true;
        window.runSnap();
        this.sqCanvas = document.getElementById("world");
        window.addEventListener("resize", () => this.windowResize());
    }

    setupTeacher() {
        if (this.videoHolder) {return;}

        if (this.model.learnerLeft) {
            this.showNote();
            return;
        }

        console.log("setup teacher");

        this.videoHolder = document.createElement("div");
        this.videoHolder.id = "videoHolder";

        this.startButton = document.createElement("div");
        this.startButton.textContent = "START";
        this.startButton.id = "startButton";

        this.startButton.addEventListener("click", (evt) => this.startButtonPressed(evt));

        document.body.appendChild(this.videoHolder);
        document.body.appendChild(this.startButton);

        document.addEventListener("keydown", (evt) => this.handleEvent(evt), false);
        document.addEventListener("keypress", (evt) => this.handleEvent(evt), false);
        document.addEventListener("keyup", (evt) => this.handleEvent(evt), false);
        this.videoHolder.addEventListener("mousedown", (evt) => this.handleEvent(evt), false);
        this.videoHolder.addEventListener("mousemove", (evt) => this.handleEvent(evt), false);
        this.videoHolder.addEventListener("mouseup", (evt) => this.handleEvent(evt), false);
    }

    startButtonPressed(_evt) {
        this.publish(this.model.id, "refresh-video", this.viewId);
        this.startButton.remove();
    }

        windowResize() {
        this.publishScreenExtent();
    }

        publishScreenExtent() {
         if (this.isLearner() && this.sqCanvas) {
            this.publish(this.model.id, "presenter-screen-extent", {
                width: this.sqCanvas.width,
                height: this.sqCanvas.height,
            });
         }
     }

    async onUserPublished(user, mediaType) {
        console.log("user published");
        await this.client.subscribe(user, mediaType);
        if (mediaType === "video") {
            this.playVideoTrack(user.videoTrack);
        }
    }

    onUserUnpublished() {
        if (this.videoHolder) {this.videoHolder.innerHTML = "";}
    }

    playVideoTrack(track) {
        if (this.videoTrack) {return;}// learner

        this.removeStartButton();
        track.play("videoHolder", {fit: "contain"});
    }

    flipAPixel() {
        this.flipColor = this.flipColor === "black" ? "white" : "black";
        if (this.isLearner() && this.sqCanvas) {
            const ctx = this.sqCanvas.getContext("2d");
            ctx.fillStyle = this.flipColor;
            ctx.fillRect(0, 0, 1, 1);
        }
    }

    onRefreshRequested(remoteViewId) {
        if (this.isLearner() && this.sqCanvas) {
            this.ensureRemoteCursor(remoteViewId);
            window.sqStartUp(this);
            this.windowResize();
            const ctx = this.sqCanvas.getContext("2d");
            ctx.fillStyle = "black";
            ctx.fillRect(0, 0, 1, 1);
        }
    }

    onRemoteDomEvent(data) {
        if (!this.videoTrack) {return;}
        let id = data.from;
        let remoteCursor = this.remoteCursors[id];

        if (remoteCursor && remoteCursor.sqRcvEvt) {
            remoteCursor.sqRcvEvt(data);
        }
    }

    refreshUIState() {
    }

    onSharingScreen(_viewId) {
        this.refreshUIState();
    }

    onStoppedSharingScreen() {
        this.refreshUIState();
    }

    handleEvent(evt) {
        if (!this.videoHolder) {return;}
        const obj = this.encodeEvent(evt);
        if (!obj) {return;}

        this.publish(this.model.id, "dom-event", obj);
    }

    encodeEvent(evt) {
        const p = this.model.presenterExtent;
        if (p.width === 0 || p.height === 0) {
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

        let mod = 0;

        if (evt.metaKey) {mod |= 1;}
        if (evt.altKey) {mod |= 2;}
        if (evt.ctrlKey) {mod |= 4;}
        if (evt.shiftKey) {mod |= 8;}

        if (evt.type === "keydown" || evt.type === "keypress" || evt.type === "keyup") {
            return {
                type: evt.type,
                clientX: (evt.clientX - offsetX) / scale,
                clientY: (evt.clientY - offsetY) / scale,
                offsetX: (evt.clientX - offsetX) / scale,
                offsetY: (evt.clientY - offsetY) / scale,
                keyCode: evt.keyCode,
                mod,
                from: this.viewId
            };
        }

        return {
            type: evt.type,
            clientX: (evt.clientX - offsetX) / scale,
            clientY: (evt.clientY - offsetY) / scale,
            offsetX: (evt.clientX - offsetX) / scale,
            offsetY: (evt.clientY - offsetY) / scale,
            buttons: evt.buttons,
            button: evt.button,
            mod,
            from: this.viewId,
        };
    }

    closeTracks() {
        console.log("close tracks");
        this.isSharing = false;
        if (this.mediaTrack) {
            this.mediaTrack.stop();
            this.mediaTrack = null;
        }

        if (this.videoTrack) {
            this.client.unpublish(this.videoTrack);
            this.videoTrack = null;
        }

        this.stream = null;
    }
}

function join() {
    import("./key.js").then((mod) => {
        window.key = mod.key;
    }).then(() => {
        Croquet.Session.join({
            appId: "io.croquet.snapscreen2",
            name: Croquet.App.autoSession("q"),
            password: "secret",
            model: RTCModel,
            view: RTCView,
            tps: 0,
            autoSleep: false
        })
    }).then(session => {
        window.session = session;
    });
}

window.onload = join;
