//************************import module  *************************************************
var express = require("express");
var commander = require("commander");

var http = require("http");
var child_process = require("child_process");
var fs = require("fs");
var path = require("path");
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
		.option("--fps <floating point number in range["+MIN_FPS+"-"+MAX_FPS+"]>", "default frames per second. Default is "+(__def=3), __def)
		.option("--verbose", "enable detail log")
		.option("--dump", "enable dump data (hex)")
		.parse(process.argv);
})();

//************************global var  ****************************************************
var UPLOAD_LOCAL_DIR="android"; //based on current file directory
var CR=0xd, LF=0xa;
var BUF_CR = new Buffer([CR]);
var BOUNDARY_STR = "----boundary----";
var BOUNDARY_AND_PNG_TYPE = new Buffer(BOUNDARY_STR+"\r\nContent-Type: image/png\r\n\r\n");
var PNG_TAIL_LEN = 8;
var PNG_FLUSH_LEN = 4096;
var PNG_CACHE_LEN = PNG_FLUSH_LEN + PNG_TAIL_LEN-1;

//************************common *********************************************************
function log(msg) {
	if (log._lineNotEnded) process.stderr.write("\n");
	 //write head as format 01/31 23:59:59.999
	var x = new Date();
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

var regex_meta_shell_char = /[><;&|(){},`$"']/g;
function __escapeChar(c) {
	return "\\"+c;
}

function spwan_child_process(args, on_error) {
	var childProc;

	function on_parent_exit(){
		log("kill child process "+childProc.pid+" due to current process exit");
		childProc.kill();
	}
	process.on("exit", on_parent_exit);

	var cmdline = "";
	args.forEach(function(arg) {
		arg = String(arg).replace(regex_meta_shell_char, __escapeChar);
		if (arg.indexOf(" ") >= 0) {
			if (arg.indexOf("\"") >= 0)
				arg.replace(" ", "\\ ");
			else
				arg = '"' + arg + '"';
		}
		cmdline += " " + arg;
	});
	log("spwan child process:\n"+cmdline);

	childProc = child_process.spawn(args[0], args.slice(1));
	log("child process pid: "+childProc.pid);

	childProc.on("error", function(err){
		err = "spwan_child_process failed ("+String(err).replace("spawn OK","spawn failed")+")";//Windows OS return strange error text
		logd(err);
		process.removeListener("exit", on_parent_exit);
		on_error(err);
	});

	childProc.on("exit", function(ret, signal) {
		logd("child process "+childProc.pid+" exited (ret:"+ret+", sig:"+signal+")");
		process.removeListener("exit", on_parent_exit);
	});

	return childProc;
}

function htmlEncode(text) {
    return String(text)
    .replace(/&(?!\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
	var childProc = spwan_child_process( [argv.adb, "version"], on_error );

	childProc.stdout.on("data", log_);
	childProc.stderr.on("data", log_);

	childProc.on("exit", function(ret) {
		if (ret===0) //todo: Windows OS to be confirmed if invalid adb path
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
	var childProc = spwan_child_process( [argv.adb, "devices"], on_error );

	var result = "";
	childProc.stdout.on("data", function(buf) {
		log_(buf);
		result += buf;
	});

	childProc.stderr.on("data", log_);

	childProc.on("exit", function(ret) {
		if (ret===0) { //todo: Windows OS to be confirmed if invalid adb path
			var deviceList = [];
			result.split("\n").slice(1/*from second line*/, onlyFirst ? 1/*only one line*/ : undefined/*all lines*/)
			.forEach( function(lineStr) {
				var parts = lineStr.split("\t");
				if (parts.length > 1)
					deviceList.push(parts[0]);
			});
			if (deviceList.length)
				on_ok( onlyFirst ? deviceList[0] : deviceList);
			else
				on_error("no any device");
		} else
			on_error("get_all_device_serial_number failed (ret!=0)");
	});
}

function get_first_device_serial_number(on_ok, on_error) {
	return get_all_device_serial_number(on_ok, on_error, true/*onlyFirst*/);
}

/*
* get device description
*/
function get_device_description(device, on_ok, on_error, userData) {
	log("get_device_description for " + device);
	var childProc = spwan_child_process( [argv.adb, "-s", device, "shell", "echo"
		, "`"
		, "getprop", "ro.product.model", ";"
		, "getprop", "o.build.version.incremental", ";"
		, "getprop", "ro.product.manufacturer", ";"
		, "getprop", "ro.build.version.release", ";"
		, "getprop", "ro.build.version.sdk", ";"
		, "getprop", "ro.product.cpu.abi", ";"
		, "`"], on_error );

	var result = "";
	childProc.stdout.on("data", function(buf) {
		log_(buf);
		result += buf;
	});

	childProc.stderr.on("data", log_);

	childProc.on("exit", function(ret) {
		if (ret===0) //todo: Windows OS to be confirmed if invalid adb path
			on_ok(result, device, userData);
		else
			on_error("get_device_description for "+device+" failed (ret!=0). Maybe the serial number is not valid or device is offline");
	});
}

function get_all_device_description(on_ok, on_error, filterDevice/*filter*/) {
	if (filterDevice) {
		get_device_description(filterDevice, on_ok, on_error, [filterDevice]);
	} else {
		get_all_device_serial_number(function(deviceList){
			deviceList.forEach(function(device) {
				if (!filterDevice || device==filterDevice)
					get_device_description(device, on_ok, on_error, deviceList);
			});
		}, on_error);
	}
}

/*
* upload all necessary files to android
*/
function upload_file(device, on_ok, on_error) {

	var local_version = fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","ffmpeg.armv7")).mtime.valueOf().toString(36) + "." +
	                    fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","ffmpeg.armv5")).mtime.valueOf().toString(36) + "." +
	                    fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","get-raw-image-4.1.2")).mtime.valueOf().toString(36) + "." +
	                    fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","get-raw-image-4")).mtime.valueOf().toString(36) + "." +
	                    fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh_","get-raw-image-old")).mtime.valueOf().toString(36) + "." +
	                    fs.statSync(path.join(UPLOAD_LOCAL_DIR,"run.sh")).mtime.valueOf().toString(36);

	__get_remote_version();

	function __get_remote_version() {
		log("__get_remote_version");
		var childProc = spwan_child_process( [argv.adb, "-s", device, "shell", "cat", argv.rdir+"/version", "2>","/dev/null"], on_error );

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
			remote_version = remote_version.replace("\r\n","").replace("\n","");

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
		var childProc = spwan_child_process( [argv.adb, "-s", device, "push", UPLOAD_LOCAL_DIR, argv.rdir], on_error );

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
		var childProc = spwan_child_process( [argv.adb, "-s", device, "shell", "echo", local_version, ">", argv.rdir+"/version"], on_error );

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
* create context for screen-capture-child-process
*/
function createCaptureContext(type, fps) {
	var cc = {
		consumerMap: {},
		lastConsumerId: 0,
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

var sharedContext = createCaptureContext();

/*
* capture screen, send result to output stream and file
*/
function capture( res, type, device, fps /*from here is internal arguments*/, theConsumer, __skip_upload ) {
	var cc;
	/*
	* check arguments
	*/
	if (!theConsumer) {
		log("capture");

		/*
		* check arguments
		*/
		if (type=="png") {
			fps = check_fps(fps, 0/*min*/, MAX_FPS, argv.fps);
			cc = fps ? sharedContext : createCaptureContext(type, fps); //png+ fps 0 means single png, create a seperate process for it
		}
		else if (type=="webm") {
			fps = check_fps(fps, MIN_FPS, MAX_FPS, argv.fps);
			cc = sharedContext;
		}
		else {
			log("wrong [type] argument");
			res.end("wrong [type] argument");
			return;
		}

		log("use type: "+ type);
		log("use fps: "+fps);

		if (cc===sharedContext) {
			/*
			* kill incompatible shared child process and all consumers
			*/
			if (cc.childProc && (cc.type != type || cc.fps < fps || type=="webm"/*todo: delete this condition*/))
				__cleanup_all(cc, "there are already capture process running with different type or lower fps");


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
		log("consumer " + theConsumer.id + " is added");

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


		/*
		* run adb command to get first device serial number if not specified
		*/
		if (!device) {
			get_first_device_serial_number( function /*on_ok*/(device) {
				capture(res, type, device, fps, theConsumer);
			}, theConsumer.on_error);
			return;
		}
	}
	else
		cc = theConsumer.cc;

	if (cc.childProc) {
		logd("use existing child process");
		return;
	}

	if (!__skip_upload) {
		/*
		* upload utility files if no running capture process
		*/
		upload_file( device, function /*on_ok*/() {
			capture(res, type, device, fps, theConsumer, true/*__skip_upload*/);
		}, theConsumer.on_error);
		return;
	}

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
	* execute child process.
	*/
	cc.childProc = spwan_child_process( [argv.adb, "-s", device, "shell", argv.rdir+"/run.sh", fps, fps||1, FFMPEG_OUTPUT, "2>", argv.rlog], theConsumer.on_error );

	cc.childProc.stdout.on("data", cc.on_childProc_stdout);
	cc.childProc.stderr.on("data", cc.on_childProc_stderr);
	cc.childProc.on("error", cc.on_childProc_error);
	cc.childProc.on("exit", cc.on_childProc_exit);
}

function __on_childProc_stdout(cc, buf) {
	logd_(buf.length);
	__convertCRLFtoLF(cc, buf).forEach( function(buf) {
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
	__cleanup_all(cc, "spwan_child_process failed ("+String(err).replace("spawn OK","spawn failed")+")" );
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
	var cc = consumer.cc;
	log("clean_up consumer "+consumer.id + " of child process " + (cc.childProc?cc.childProc.pid:"?") + (reason ? (" due to "+reason) : ""));

	//unsbscribe
	delete cc.consumerMap[consumer.id];

	//for http output stream, output reason
	if (reason && consumer.res.writeHead) {
		try {
			consumer.res.writeHead(200, {"Content-Type": "text/html"});
			consumer.res.write(reason);
		}
		catch(e) {
		}
	}

	//close output stream
	consumer.res.end();  //OK, seems not trigger close event of the stream

	//if no consumer subscribe the output of child process, then kill it
	if (cc.childProc && !Object.keys(cc.consumerMap).length) {
		log("kill child process "+cc.childProc.pid+" due to all consumer are closed");

		//todo: really need this? what about private context?
		cc.childProc.stdout.removeListener("data", cc.on_childProc_stdout);
		cc.childProc.stderr.removeListener("data", cc.on_childProc_stderr);
		cc.childProc.removeListener("error", cc.on_childProc_error);
		cc.childProc.removeListener("exit", cc.on_childProc_exit);

		cc.childProc.kill(); //todo: Does this trigger close event?
		cc.childProc = null;
	}
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
			cc.pngCacheLength = PNG_FLUSH_LEN;
			Object.keys(cc.consumerMap).forEach(__writePngCache);

			cc.pngCache.copy( cc.pngCache, 0, PNG_FLUSH_LEN);
			cc.pngCacheLength = PNG_CACHE_LEN-PNG_FLUSH_LEN;
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
* convert CRLF to LF, return array of converted buf
*/
function __convertCRLFtoLF(cc, buf) {
	if (argv.dump)
		log(buf.toString("hex"));

	var prependCR = false;
	var lastTime;

	if (cc.hasOrphanCR) {
		if (buf[0] != LF) {
			prependCR = true;
			//logd_("r");
			if (argv.verbose) {
				var diffMs = new Date()-lastTime;
				if (diffMs > 100) {
					//logd_("L"+diffMs);
				}
			}
		}
		cc.hasOrphanCR = false;
	}

	//convert CRLF to LF
	var len = buf.length;
	for(var i=0; i<len; i++) {
		if (buf[i]==CR) {
			if (i+1<len) {
				if (buf[i+1]==LF ) {
					//logd_("n");
					buf.copy(buf, i, i+1);
					len--;
				}
			}
			else {
				cc.hasOrphanCR = true;
				len--;
				break;
			}
		}
	}

	if (argv.verbose)
		lastTime = new Date();

	return prependCR ? [BUF_CR, buf.slice(0,len)] : [buf.slice(0,len)];
}//end of __convertCRLFtoLF()

function __write(res, bufOrString ) {
	logd_(">");
	if (res.write(bufOrString))
		logd_(".");
	else
		logd_("&");
}


function start_stream_server() {
	log("start_stream_server");

	var app = express();
	// Server settings
	//app.set("views", path.join(__dirname, "views"));
	//app.set("view engine", "ejs");
	app.use(express.favicon());
	app.use(express.logger("dev"));
	app.use(express.bodyParser());
	app.use(express.methodOverride());
	app.use(app.router);
	//app.use("/", express["static"](path.join(__dirname, "html")));
	app.use(express.errorHandler());

	/*
	* serve webm video or png image
	*/
	app.get("/capture",function(req,res){
		log("process request: " + req.url);
		capture(res, req.query.type, req.query.device, req.query.fps);
	});

	/*
	* menu page
	*/
	app.get("/",function(req,res){
		log("process request: " + req.url);
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
				var i = 0;
				get_all_device_description( function /*on_ok*/(description, device, deviceList) {
					if (!i)
						res.write("<table border=1><tr><th>device serial number</th><th>description</th><th>video/image</th></tr>");
					
					res.write("<tr><td>"+htmlEncode(device)+"</td><td>"+description+"</td><td>");

					if (!req.query.type || req.query.type=="webm")
						res.write('<a href="/?type=webm&device='+querystring.escape(device)+'&fps='+querystring.escape(fps)+'">webm video</a><br/>');
					if (!req.query.type || req.query.type=="png")
						res.write('<a href="/?type=png&device='+querystring.escape(device)+'&fps='+querystring.escape(fps)+'">png image</a>');

					res.write("</td></tr>");

					if (i==deviceList.length-1) {
						//res.write("</table>");
						res.end();
					}
					i++;
				}, function /*on_error*/(err) {
					res.end(err);
				}, req.query.device/*filter*/ );
			}
		}
		else if (req.query.type) {
			res.end("no such type");
		}
	});

	// Start server
	argv.ip = argv.ip||"0.0.0.0";
	log("Express server is trying to listen on port " + argv.port + " of "+
		((argv.ip=="0.0.0.0")?"all network interfaces":argv.ip) );
	http.createServer(app).listen(argv.port, argv.ip, function(){
		var rootUrl = "http://localhost:"+ argv.port;
		log_("\nOK. Now you can:\n"+
			"----Watch video/image in browser from menu page "+rootUrl+"\n\n"+
		    "----Embed webm video url into <video> tag of your web page. For example:\n"+
		    fs.readFileSync(path.join("html","webm.html")).toString()
				.replace("/capture?", rootUrl+"/capture?")
				.replace("<%device%>", "12345678")
				.replace("<%fps%>", 4) + "\n\n" +
		    "----Embed animated png into your web page. For example:\n"+
		    fs.readFileSync(path.join("html","png.html")).toString()
				.replace("/capture?", rootUrl+"/capture?")
				.replace("<%device%>", "12345678")
				.replace("<%fps%>", 4) + "\n\n" +
			"Note: [device] argument can be omitted, which means the first connected device.\n"+
			"      [fps] argument means frames per second.\n"+
			"          It should be a floating point number in range ["+MIN_FPS+"-"+MAX_FPS+"].\n"+
			"      Please ensure that you have installed USB driver of your android.\n"+
			"      Connect USB cable to android, enable USB debug (only first time),\n"+
			"      and finally TURN ON screen(otherwise you see black screen), now enjoy it!"+
			"\n"
		);
	})
	.on("error", function(err) {
		log("httpServer!:"+err);
		delayAbort("httpServer error");
	});
}

check_adb( start_stream_server/*on_ok*/, delayAbort/*on_error*/);
