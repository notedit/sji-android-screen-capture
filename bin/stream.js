//************************import module  *************************************************
var commander = require("commander");

var http = require("http");
var child_process = require("child_process");
var fs = require("fs");
var path = require("path");
var url = require("url");
var querystring = require("querystring");

//************************command line  **************************************************
var MIN_FPS=1;
var MAX_FPS=25;
var argv = (function() {
    function _parseInt(s) { var i = parseInt(s,0); if (i==s) return i; else { log("invalid int: '"+s+"'"); process.exit(1); }}
    function _check_fps(s) { var i = check_fps(s,MIN_FPS,MAX_FPS,NaN); if (!isNaN(i)) return i; else { log("invalid frames_per_second: '"+s+"'"); process.exit(1); }}
    var __def;
    return commander
        .option("--adb <path>", "adb(Android Debug Bridge) utility path. Default is "+(__def="adb"), __def)
        .option("--port <int>", "stream server public port. Default is "+(__def=3000), _parseInt, __def)
        .option("--ip <ip>", "stream server public address. Default is "+(__def="0.0.0.0")+"(all)", __def)
        .option("--adminport <int>", "stream server admin port. Default is "+(__def=3001), _parseInt, __def)
        .option("--vfmax <int>", "video file max size. Default is "+(__def=100*1024*1024), _parseInt, __def)
        .option("--vfdir <dir>", "video file dir. Default is "+(__def="video"), __def)
        .option("--rlog <android path>", "android log file path. Default is "+(__def="/sdcard/sji-asc.log"), __def)
        .option("--rdir <android dir>", "android work dir. Default is "+(__def="/data/local/tmp/sji-asc"), __def)
        .option("--fps <floating point number in range["+MIN_FPS+"-"+MAX_FPS+"]>", "default frames per second. Default is "+(__def=10), __def)
        .option("--verbose", "enable detail log")
        .option("--dump", "enable dump first 32 byte of raw data when received from adb")
        .parse(process.argv);
})();

//************************global var  ****************************************************
var UPLOAD_LOCAL_DIR="android"; //based on current file directory
var CR=0xd, LF=0xa;
var BUF_CR2 = new Buffer([CR,CR]);
var BUF_CR = BUF_CR2.slice(0,1);
var BOUNDARY_STR = "----boundary----";
var BOUNDARY_AND_PNG_TYPE = new Buffer(BOUNDARY_STR+"\r\nContent-Type: image/png\r\n\r\n");
var PNG_CACHE_LEN = 4096;
var PNG_TAIL_LEN = 8;

var isWinOS = process.platform.match(/^win/);
var isMacOS = process.platform.match(/^darwin/);
var adbNewLineSeqCrCount = isWinOS ? 2 : isMacOS ? 1 : 0; //will be set again when call __get_remote_version
var re_adbNewLineSeq = /\r?\r?\n$/;
var re_toBeEscapedCharForShell = isWinOS ? /["]/g : /["'><&|;(){}`$]/g;
var re_toBeQuotedCharForShell = isWinOS ? /[><&|%]/g : null;
var re_whitespace = /\s/g;

//device manager (Key: device serial number)
var devMgr = {
    /*
    deviceSerialNumberXxxx: {
        desc: {desc:aaaa, haveErr:true/false},
        sharedCaptureContext: {consumerMap...}
    },
    deviceSerialNumberYyyy: {
        desc: {desc:bbbb, haveErr:true/false},
        sharedCaptureContext: {consumerMap...}
    }
    */
};

//************************common *********************************************************
function log(msg) {
    if (log._lineNotEnded) process.stderr.write("\n");
     //write head as format 01/31 23:59:59.999
    if (log.__dtNow)
        log.__dtNow.setTime(Date.now());
    else
        log.__dtNow = new Date();
    var x = log.__dtNow;
    process.stderr.write(("00"+x.getMonth()).slice(-2) + "/" + ("00"+x.getDay()).slice(-2) + " " + ("00"+x.getHours()).slice(-2) + ":" + ("00"+x.getMinutes()).slice(-2) + ":" + ("00"+x.getSeconds()).slice(-2) + "." + ("000"+x.getMilliseconds()).slice(-3)+" ");
    log_(msg);
    process.stderr.write("\n");
    log._lineNotEnded = false;
}
function log_(msg) {
    process.stderr.write(Buffer.isBuffer(msg) ? msg : String(msg));
    log._lineNotEnded = true;
}
function logd(msg) {
    if (argv.verbose) log(msg);
}
function logd_(msg) {
    if (argv.verbose) log_(msg);
}

function delayAbort(err) {
    setTimeout(function(){
        log("abort (ret=1) due to "+err);
        process.exit(1);
    },0);
}

function __escapeChar(c) {
    return "\\"+c;
}
function __quoteChar(c) {
    return "\""+c+"\"";
}

function spawn_child_process(args, on_error) {
    var childProc;

    function on_parent_exit(){
        log("kill child process "+childProc.pid+" due to current process exit");
        childProc.kill();
    }
    process.on("exit", on_parent_exit);

    //just to make a display string of command line
    var cmdline = "";
    args.forEach(function(arg) {
        arg = String(arg).replace(re_toBeEscapedCharForShell, __escapeChar);
		if (re_toBeQuotedCharForShell) arg = arg.replace(re_toBeQuotedCharForShell, __quoteChar);
        if (arg.indexOf('"')>=0)
            arg = arg.replace(re_whitespace, __escapeChar);
        else if (re_whitespace.test(arg))
            arg = '"' + arg + '"';
        cmdline += " " + arg;
    });
    log("spwan child process:\n"+cmdline);

    childProc = child_process.spawn(args[0], args.slice(1));
    log("child process pid: "+childProc.pid);

    childProc.on("error", function(err){
        err = "spawn_child_process failed ("+String(err).replace("spawn OK","spawn failed")+")";//Windows OS return strange error text
        log(err);
        process.removeListener("exit", on_parent_exit);
        on_error(err);
    });

    childProc.on("exit", function(ret, signal) {
        log("child process "+childProc.pid+" exited (ret:"+ret+", sig:"+signal+")");
        process.removeListener("exit", on_parent_exit);
    });

    return childProc;
}

function htmlEncode(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

//****************************************************************************************
/*
* check frames_per_second
*/
function check_fps(fps, min, max, def) {
    var i = parseInt(fps,0);
    if (i!=fps) {
        i=parseFloat(fps,0);
        if (i!=fps)
            return def;
    }
    return (i >= min && i <= max) ? i : def;
}


/*
* check adb availability
*/
function check_adb(on_ok, on_error) {
    log("check_adb");
    var childProc = spawn_child_process( [argv.adb, "version"], on_error );

    childProc.stdout.on("data", log_);
    childProc.stderr.on("data", log_);

    childProc.on("exit", function(ret) {
        if (ret===0)
            on_ok();
        else
            on_error("check_adb failed (ret!=0)");
    });
}

/*
* get all device serial number
*/
function get_all_device_serial_number(on_ok, on_error, onlyFirst) {
    log("get_all_device_serial_number "+(onlyFirst?"(onlyFirst)":""));
    var childProc = spawn_child_process( [argv.adb, "devices"], on_error );

    var result = "";
    childProc.stdout.on("data", function(buf) {
        log_(buf);
        result += buf;
    });

    childProc.stderr.on("data", log_);

    childProc.on("exit", function(ret) {
        if (ret===0) {
            var snList = [];
            result.split("\n").slice(1/*from second line*/, onlyFirst ? 1/*only one line*/ : undefined/*all lines*/)
            .forEach( function(lineStr) {
                var parts = lineStr.split("\t");
                if (parts.length > 1)
                    snList.push(parts[0]);
            });
            if (snList.length)
                on_ok( onlyFirst ? snList[0] : snList);
            else
                on_error("no any device");
        } else
            on_error("get_all_device_serial_number failed (ret!=0)");
    });
}

function get_first_device_serial_number(on_ok, on_error) {
    return get_all_device_serial_number(on_ok, on_error, true/*onlyFirst*/);
}

function __createDeviceContext(sn) {
    return {
        sn: sn,
        desc: {desc:"Unkown", haveErr:true}
    };
}

/*
* get device description
*/
function get_device_desc(sn, on_ok, on_error, timeoutMs) {
    log("get_device_desc for " + sn);
    var childProc = spawn_child_process( [argv.adb, "-s", sn, "shell", "echo",
        "`",
        "getprop", "ro.product.model", ";",
        "getprop", "o.build.version.incremental", ";",
        "getprop", "ro.product.manufacturer", ";",
        "getprop", "ro.build.version.release", ";",
        "getprop", "ro.build.version.sdk", ";",
        "getprop", "ro.product.cpu.abi", ";",
        "`"
        ], on_error );

    var desc = "";
    childProc.stdout.on("data", function(buf) {
        log_(buf);
        desc += buf;
    });

    childProc.stderr.on("data", log_);

    var isExpired = false;
    var timer;
    if (timeoutMs) {
        timer = setTimeout(function(){
            isExpired = true;
            on_error("Timeout. Maybe invalid serial number or device is offline");
        }, timeoutMs);
    }

    childProc.on("exit", function(ret) {
        if (timeoutMs && timer)
            clearTimeout(timer);

        if (ret===0) {
            desc = desc.replace(re_adbNewLineSeq, "");
            if (devMgr[sn])
                devMgr[sn].desc = {desc: desc, haveErr: false};
            on_ok(desc, isExpired);
        }
        else {
            var err = "Invalid serial number or device is offline";
            if (devMgr[sn])
                devMgr[sn].desc = {desc: err, haveErr: true};
            on_error(err, isExpired);
        }
    });
}

/*
* get all device description
*/
function get_all_device_desc(on_ok, on_error, sn/*filter*/) {
    get_all_device_serial_number(function/*on_ok*/(snList) {
        //reset existence flag of all sn in devMgr
        Object.keys(devMgr).forEach( function(sn) {
            devMgr[sn].visible = false;
        });
        //ensure create all device context
        snList.forEach( function(sn) {
            if (!devMgr[sn]) devMgr[sn] = __createDeviceContext(sn);
            devMgr[sn].visible = true;
        });

        //reduce snList
        if (sn) {
            if (snList.indexOf(sn) >=0)
                snList = [sn];
            else
                return on_error("no such device serial number: "+sn);
        }

        //get description of device one by one
        var i=0;
        function __get_next_device_desc() {
            if (i < snList.length) {
                var sn = snList[i++];

                get_device_desc(sn, function/*on_ok*/(desc, isExpired) {
                    if (!isExpired)
                        __get_next_device_desc();
                }, function/*on_error*/(err, isExpired) {
                    if (!isExpired)
                        __get_next_device_desc();
                }, 1000/*timeoutMs*/);
            }
            else {
                //ok, got all device's description
                on_ok();
            }
        }

        //start query!
        __get_next_device_desc();

    }, on_error);
}

function __delete_adbNewLineSeq_and_remember(adbNewLineSeq) {
    adbNewLineSeqCrCount = adbNewLineSeq.length-1;
    log("adbNewLineSeqCrCount:"+adbNewLineSeqCrCount);
    return "";
}

/*
* upload all necessary files to android
*/
function upload_file(sn, on_ok, on_error) {

    var local_version = fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","ffmpeg.armv7")).mtime.valueOf().toString(36) + "." +
                        fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","ffmpeg.armv5")).mtime.valueOf().toString(36) + "." +
                        fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","get-raw-image-4.1.2")).mtime.valueOf().toString(36) + "." +
                        fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","get-raw-image-4")).mtime.valueOf().toString(36) + "." +
                        fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","get-raw-image-old")).mtime.valueOf().toString(36) + "." +
                        fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh")).mtime.valueOf().toString(36) + "." +
                        fs.statSync(__filename).mtime.valueOf().toString(36);

    __get_remote_version();

    function __get_remote_version() {
        log("__get_remote_version");
        var childProc = spawn_child_process( [argv.adb, "-s", sn, "shell", "echo", "`", "cat", argv.rdir+"/version", "`"], on_error );

        var remote_version = "";
        childProc.stdout.on("data", function(buf) {
            log_(buf);
            remote_version += buf;
        });

        childProc.stderr.on("data", function(buf) {
            log_(buf);
            __get_remote_version.err = true;
            on_error("get_remote_version get unexpected stdout output");
        });

        childProc.on("exit", function(ret) {
            if (__get_remote_version.err) return;
            remote_version = remote_version.replace(re_adbNewLineSeq, __delete_adbNewLineSeq_and_remember);
            if (remote_version==local_version) {
                log("same as local version");
                on_ok();
            }
            else {
                log("different as local_version:\n"+local_version);
                __upload_file();
            }
        });
    }

    function __upload_file() {
        log("__upload_file");
        var childProc = spawn_child_process( [argv.adb, "-s", sn, "push", UPLOAD_LOCAL_DIR, argv.rdir], on_error );

        childProc.stdout.on("data", log_);
        childProc.stderr.on("data", log_);

        childProc.on("exit", function(ret) {
            if (ret===0)
                __update_remote_version();
            else
                on_error("upload_file failed (ret!=0)");
        });
    }

    function __update_remote_version() {
        log("__update_remote_version");
        var childProc = spawn_child_process( [argv.adb, "-s", sn, "shell", "echo", local_version, ">", argv.rdir+"/version"], on_error );

        childProc.stdout.on("data", function(buf) {
            log_(buf);
            __update_remote_version.err = true;
            on_error("update_remote_version get unexpected stdout output");
        });

        childProc.stderr.on("data", function(buf) {
            log_(buf);
            __update_remote_version.err = true;
            on_error("update_remote_version get unexpected stderr output");
        });

        childProc.on("exit", function() {
            if (__update_remote_version.err) return;
            on_ok();
        });
    }
}

/*
* create context for screen capture process of the device
*/
function __createCaptureContext(sn, type, fps) {
    var cc = {
        consumerMap: {},
        lastConsumerId: 0,
        sn: sn,
        type: type,
        fps: fps
    };
    //bind some callback's first argument = cc, so make each function take less argument
    cc.on_childProc_stdout = __on_childProc_stdout.bind(null, cc);
    cc.on_childProc_stderr = __on_childProc_stderr.bind(null, cc);
    cc.on_childProc_error = __on_childProc_error.bind(null, cc);
    cc.on_childProc_exit = __on_childProc_exit.bind(null, cc);
    return cc;
}

/*
* capture screen, send result to output stream and file
*/
function capture( sn, res, type, fps /*from here is internal arguments*/, theConsumer, cc ) {
    /*
    * check arguments
    */
    if (!theConsumer) {
        log("capture sn:["+sn+"] type:["+type+"] fps:["+fps+"]");

        if (!sn)
            return __endOutputStreamWithInfo(res, "no [sn] argument", true/*show log*/);

        /*
        * ensure init device context and shared capture context of the device
        */
        if (!devMgr[sn]) devMgr[sn] = __createDeviceContext(sn);
        if (!devMgr[sn].sharedCaptureContext) devMgr[sn].sharedCaptureContext = __createCaptureContext(sn, type, fps);

        /*
        * use shared capture context or private capture context according to type and fps
        */
        var oldFps = fps;
        if (type=="png") {
            fps = check_fps(fps, 0/*min*/, MAX_FPS, argv.fps);
            cc = fps ? devMgr[sn].sharedCaptureContext : __createCaptureContext(sn, type, fps); //png+ fps 0 means single png, create a seperate process for it
        }
        else if (type=="webm") {
            fps = check_fps(fps, MIN_FPS, MAX_FPS, argv.fps);
            cc = devMgr[sn].sharedCaptureContext;
        }
        else
            return __endOutputStreamWithInfo(res, "wrong [type] argument", true/*show log*/);

        if (fps!=oldFps)
            log("["+sn+"]"+"use fps: "+fps);

        if (cc===devMgr[sn].sharedCaptureContext) {
            /*
            * kill incompatible shared capture process and all consumers
            */
            if (cc.childProc && (cc.type != type || cc.fps < fps || type=="webm"/*todo: delete this condition*/))
                __cleanup_all(cc, "capture process running with different type or lower fps");


            if (!cc.childProc) {
                //replace type, fps of shared context
                cc.type = type;
                cc.fps = fps;
            }
        }

        /*
        * add consumer
        */
        theConsumer = {};
        theConsumer.res = res;
        theConsumer.cc = cc;
        theConsumer.id = ++cc.lastConsumerId;
        theConsumer.on_error = __cleanup.bind(null, theConsumer); //bound first argument=theConsumer
        cc.consumerMap[theConsumer.id] = theConsumer;
        log("["+sn+"]"+"consumer " + theConsumer.id + " is added");

        /*
        * set stream error handler to prevent from crashing
        * todo: why need this? why not move it to app.use(function(req,res......){.....}) ?
        */
        res.on("error", function(err) {
            theConsumer.on_error("output stream error ("+err+")");
        });

        /*
        * set close handler of output stream.
        */
        res.on("close", function(){
            theConsumer.on_error("output stream is closed");
        });

        if (!cc.childProc)
            /*
            * upload utility files if no running capture process
            */
            return upload_file( sn, function /*on_ok*/() {
                capture(sn, res, type, fps, theConsumer, cc);
            }, theConsumer.on_error);
    }

    if (cc.childProc)
        return log("["+sn+"]"+"use existing capture process");

    //------------------------------------------------------------------------
    //------------------start new capture process ----------------------------
    //------------------------------------------------------------------------

    /*
    * set ffmpeg output option
    * "-" means stdout
    */
    var FFMPEG_OUTPUT;
    if (type=="png") {
        if (fps) //continuously output png
            FFMPEG_OUTPUT="-f image2 -vcodec png -update 1 -";
        else //Only output 1 png
            FFMPEG_OUTPUT="-f image2 -vcodec png -vframes 1 -";
    }
    else if (type=="webm")
        FFMPEG_OUTPUT="-f webm -vcodec libvpx -rc_lookahead 0 -qmin 0 -qmax 20 -b:v 1000k -";

    /*
    * execute capture process.
    */
    cc.childProc = spawn_child_process( [argv.adb, "-s", sn, "shell", "sh", argv.rdir+"/run.sh", fps, fps||1, FFMPEG_OUTPUT, "2>", argv.rlog], theConsumer.on_error );

    cc.childProc.stdout.on("data", cc.on_childProc_stdout);
    cc.childProc.stderr.on("data", cc.on_childProc_stderr);
    cc.childProc.on("error", cc.on_childProc_error);
    cc.childProc.on("exit", cc.on_childProc_exit);
}

function __on_childProc_stdout(cc, buf) {
    logd_(buf.length+":");
    __convertAdbNewLineSeqToLF(cc, buf).forEach( function(buf) {
        if (cc.type=="png")
            __writePng(cc, buf, 0, buf.length);
        else if (cc.type=="webm")
            __writeWebm(cc, buf, 0, buf.length);
    });
}

function __on_childProc_stderr(cc, buf) {
    log_(buf);
    __cleanup_all(cc, "unexpected stderr output of shared capture process "+cc.childProc.pid);
}

function __on_childProc_error(cc, err) {
    __cleanup_all(cc, "spawn_child_process failed ("+String(err).replace("spawn OK","spawn failed")+")" );
}

function __on_childProc_exit(cc, ret, signal) {
    __cleanup_all(cc, "shared capture process "+cc.childProc.pid+" exited (ret:"+ret+", sig:"+signal+")" );
}

function __cleanup_all(cc, reason) {
    Object.keys(cc.consumerMap).forEach( function(consumerId) {
        __cleanup(cc.consumerMap[consumerId], reason);
    });
}

function __cleanup(consumer, reason) {
    //prevent endless loop by error event of the output stream
    if (consumer.didCleanup) return;
    consumer.didCleanup = true;

    var cc = consumer.cc;
    log("["+cc.sn+"]"+"clean_up consumer "+consumer.id + " of capture process " + (cc.childProc?cc.childProc.pid:"?") + (reason ? (" due to "+reason) : ""));

    //unsbscribe
    delete cc.consumerMap[consumer.id];

    //for http output stream, output reason
    __endOutputStreamWithInfo(consumer.res, reason);

    //if no consumer subscribe the output of capture process, then kill it
    if (cc.childProc && !Object.keys(cc.consumerMap).length) {
        log("["+cc.sn+"]"+"kill capture process "+cc.childProc.pid+" due to all consumer are closed");
        cc.childProc.stdout.removeListener("data", cc.on_childProc_stdout);
        cc.childProc.stderr.removeListener("data", cc.on_childProc_stderr);
        cc.childProc.removeListener("error", cc.on_childProc_error);
        cc.childProc.removeListener("exit", cc.on_childProc_exit);
        cc.childProc.kill(); //todo: seems does not trigger close event. But cause memory leak?
        cc.childProc = null;
    }
}

function __endOutputStreamWithInfo(res, reason, showLog) {
    if (reason) {
        if (showLog)
            log(showLog);

        try {
            res.writeHead(200, {"Content-Type": "text/html"});
            res.write(reason);
        }
        catch(e) {
        }
    }

    //close output stream
    try {
        res.end();  //OK, seems not trigger close event of the stream. BUT may cause error event of res. Such as stdout.end() canse error event
    } catch(e) {}
}

/*
* write multiple png stream to all consumers
*/
function __writePng(cc, buf, pos, endPos) {
    /*
    * find head
    */
    if (!cc.pngCacheLength) {
        //mark each consumer's start flag and write http head
        Object.keys(cc.consumerMap).forEach( function(consumerId) {
            var consumer = cc.consumerMap[consumerId];
            if (consumer.res.writeHead) {
                if (cc.fps) { //continuous png
                    if (!consumer.didOutput)
                        consumer.res.writeHead(200, {"Content-Type": "multipart/x-mixed-replace; boundary="+BOUNDARY_STR});
                    __write( consumer.res, BOUNDARY_AND_PNG_TYPE);
                }
                else //single png
                    consumer.res.writeHead(200, {"Content-Type": "image/png"});
            }
            consumer.didOutput = true;
        });

        cc.pngCacheLength = 0;
        if (!cc.pngCache)
            cc.pngCache = new Buffer(PNG_CACHE_LEN);
    }

    for (  ; pos < endPos; pos++) {
        cc.pngCache[cc.pngCacheLength++] = buf[pos];
        /*
        * find tail
        */
        if (__isPngTail(cc.pngCache, cc.pngCacheLength-PNG_TAIL_LEN)) {
            //ok, png complete, write last part
            Object.keys(cc.consumerMap).forEach(__writePngCache);

            //reset parser
            cc.pngCacheLength = 0;
            pos++;

            //write out next png
            if (pos < endPos) __writePng(cc, buf, pos, endPos);

            return;
        }
        /*
        * find body
        */
        else if (cc.pngCacheLength == PNG_CACHE_LEN) {
            //move some cc.pngCache data to output stream if big enough
            cc.pngCacheLength = PNG_CACHE_LEN-(PNG_TAIL_LEN-1);
            Object.keys(cc.consumerMap).forEach(__writePngCache);
            //copy last PNG_TAIL_LEN-1 byte to head
            cc.pngCache.copy( cc.pngCache, 0, PNG_CACHE_LEN-(PNG_TAIL_LEN-1));
            cc.pngCacheLength = PNG_TAIL_LEN-1;
        }
    }

    function __writePngCache(consumerId) {
        var consumer = cc.consumerMap[consumerId];
        if (consumer.didOutput)
            __write( consumer.res, cc.pngCache.slice(0, cc.pngCacheLength) );
    }

    function __isPngTail(buf, pos) {
        if (pos < 0) return false;
        return (buf[pos++]==0x49 && buf[pos++]==0x45 && buf[pos++]==0x4E && buf[pos++]==0x44 && buf[pos++]==0xAE && buf[pos++]==0x42 && buf[pos++]==0x60 && buf[pos++]==0x82);
    }
} //end of __writePng()


/*
* write webm stream to all consumers   //todo: on working. Currently video can not be shared by multiple http connection
*/
function __writeWebm(cc, buf, pos, endPos) {
    var consumer = cc.consumerMap[Object.keys(cc.consumerMap)[0]];
    if (!consumer.didOutput) {
        consumer.didOutput = true;
        if (consumer.res.writeHead)
            consumer.res.writeHead(200, {"Content-Type": "video/webm"});
    }
    __write( consumer.res, buf );
} //end of __writeWebm()

/*
* convert CRLF(Mac) or CRCRLF(Windows) to LF, return array of converted buf
*/
function __convertAdbNewLineSeqToLF(cc, buf) {
    if (argv.dump)
        log("    " + buf.slice(0,32).toString("hex"));

    if (!adbNewLineSeqCrCount) return [buf]; //lucky! no CR prepended, so need not convert.

    var bufAry = [];
    var startPos = 0;

    /*
    * Resolve orphan [CR,CR] or [CR] which are produced by previous call of this function.
    * If it is followed by [LF] or [CR,LF], then they together are treated as a [LF],
    * Otherwise, the orphan seq will be output normally.
    */
    if (cc.orphanCrCount) {
        var restCrCount = adbNewLineSeqCrCount-cc.orphanCrCount;
        // if adbNewLineSeq is found then skip rest CR, start from LF. Otherwise push orphan CR into result
        if (!restCrCount && buf[0] ==LF || restCrCount && buf[0]==CR && buf.length>1 && buf[1]==LF)
            startPos = restCrCount;
        else
            bufAry.push(cc.orphanCrCount==2?BUF_CR2:BUF_CR);
        cc.orphanCrCount = 0;
    }

    /*
    * convert CRLF or CRCRLF to LF
    */
    var crCount = 0;
    for (var i=startPos; i < buf.length; i++) {
        if (buf[i]==CR) {
            crCount++;
            
            /*
            *if no more data to match adbNewLineSeq, then save it as orphan CR which will
            *be processed by next call of this function
            */
            if (i+1==buf.length) {
                cc.orphanCrCount = Math.min(crCount, adbNewLineSeqCrCount);
                //commit data in range from last start positon to current position-orphanCrCount
                if (startPos < buf.length-cc.orphanCrCount)
                    bufAry.push(buf.slice(startPos, buf.length-cc.orphanCrCount));
                    
                return bufAry;
            }
        }
        else {
            /*
            * if found 2 or 2 CR followed by LF, then CR will be discarded.
            * and data before CR will be pushed to result.
            */
            if (crCount >= adbNewLineSeqCrCount && buf[i]==LF) {
                //commit data in range from last start positon to current position-adbNewLineSeqCrCount
                bufAry.push(buf.slice(startPos, i-adbNewLineSeqCrCount));
                startPos = i;
            }
            
            crCount = 0;
        }
    }

    bufAry.push(buf.slice(startPos));

    if (argv.dump) {
        var s = "";
        bufAry.forEach(function(buf){
            s += buf.toString("hex");
        });
        log(" to " + s.slice(0,64));
    }
    return bufAry;
}//end of __convertAdbNewLineSeqToLF()

function __write(res, bufOrString ) {
    logd_(">");
    if (res.write(bufOrString))
        logd_(".");
    else
        logd_("&");
}

function preprocessReq(req) {
    req.query = url.parse(req.url,true/*querystring*/).query;
}

/*
* serve menu page and video/image container page
*/
function serve_menu(req,res) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate"); // HTTP 1.1.
    res.setHeader("Pragma", "no-cache"); // HTTP 1.0.
    res.setHeader("Expires", 0); // Proxies.
    res.writeHead(200, {"Content-Type": "text/html"});

    var fps = check_fps(req.query.fps, (req.query.type=="png" ? 0/*min*/ : MIN_FPS), MAX_FPS, "");

    if (!req.query.type || req.query.type=="webm" || req.query.type=="png") {
        //show video/image html for specific device
        if (req.query.type && req.query.device) {
            res.end( "Please turn on screen of the android smartphone<br/>\n" +
                fs.readFileSync(path.join("html",req.query.type+".html")).toString()
                    .replace("<%device%>", req.query.device)
                    .replace("<%fps%>", fps)
            );
        }
        //show link of all devices
        else {
            get_all_device_desc( function /*on_ok*/() {
                res.write("<table border=1><tr><th>device serial number</th><th>description</th><th>video/image</th></tr>");

                Object.keys(devMgr).forEach( function(sn) {
                    if (devMgr[sn].visible) {
                        var desc = devMgr[sn].desc;
                        res.write("<tr><td>"+htmlEncode(sn)+"</td><td>"+htmlEncode(desc.desc)+"</td><td>");

                        if (!desc.haveErr) {
                            if (!req.query.type || req.query.type=="webm")
                                res.write('<a href="/?type=webm&device='+querystring.escape(sn)+'&fps='+querystring.escape(fps)+'">WEBM video</a>');
                            if (!req.query.type || req.query.type=="png")
                                res.write('<br/><a href="/?type=png&device='+querystring.escape(sn)+'&fps='+querystring.escape(fps)+'">PNG image</a>');
                        }

                        res.write("</td></tr>");
                    }
                });

                res.write("</table>");
                res.end();
            }, function /*on_error*/(err) {
                res.end(htmlEncode(err));
            }, req.query.device/*filter*/ );
        }
    }
    else if (req.query.type) {
        res.end("no such type");
    }
}

function start_stream_server() {
    log("start_stream_server");
    
    function handler(req, res) {
        if (req.method!="GET") return;
        log("process request: " + req.url);
        if (/^\/capture¥?/.test(req.url)) { //url: /capture
            preprocessReq(req);
            /*
            * serve webm video or png image
            */
            capture(req.query.device, res, req.query.type, req.query.fps);
        }
        else if (/^\/¥??/.test(req.url)) { // url: /
            preprocessReq(req);
            /*
            * serve menu page and video/image container page
            */
            serve_menu(req, res);
        }
    }

    function showReadyMsg() {
        var rootUrl = "http://localhost:"+ argv.port+"/";;
        log_("\nOK. Now you can:\n"+
            "----Watch video/image in browser from menu page "+rootUrl+"\n\n"+
            "----Embed webm video url into <video> tag of your web page. For example:\n"+
            fs.readFileSync(path.join("html","webm.html")).toString()
                .replace("/capture?", rootUrl+"/capture?")
                .replace("<%device%>", "12345678")
                .replace("<%fps%>", 4) + "\n\n" +
            "----Embed animated PNG image into your web page. For example:\n"+
            fs.readFileSync(path.join("html","png.html")).toString()
                .replace("/capture?", rootUrl+"/capture?")
                .replace("<%device%>", "12345678")
                .replace("<%fps%>", 4) + "\n\n" +
            "Note: [device] argument can be omitted, which means the first connected device.\n"+
            "      [fps] argument means frames per second.\n"+
            "          It should be a floating point number in range ["+MIN_FPS+"-"+MAX_FPS+"].\n"+
            "          For example, 0.5 means 1 frame every 2 seconds.\n"+
            "      Please install latest Android SDK and USB driver of your android.\n"+
            "      Connect USB cable to android and enable USB debug (only first time)\n"+
            "      or set WiFi debug mode by adb tcp command."+
            "\n"
        );
    }

    // Start server
    argv.ip = argv.ip||"0.0.0.0";
    log("Express server is trying to listen on port " + argv.port + " of "+
        ((argv.ip=="0.0.0.0")?"all network interfaces":argv.ip) );
    http.createServer(handler).listen(argv.port, argv.ip, showReadyMsg)
    .on("error", function(err) {
        log("httpServer!:"+err);
        delayAbort("httpServer error");
    });
}

check_adb( start_stream_server/*on_ok*/, delayAbort/*on_error*/);
