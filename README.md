sji-android-screen-capture
===================
android screen capture (for HTML5 video live streaming)<br/>
This project is aimed to capture android screen and view it in HTML5 video capable browser.
Yes, real time, low bandwidth.
This product will do encoding in android by ffmpeg.<br/>
<a href="http://youtu.be/CWcOjzAJ6Sg">recorded video sample( converted by youtube)</a><br/>
<a href="http://youtu.be/1wZYHHzMwQ8">Usage video</a><br/>

[Screenshot]<br/>
<img src="doc/screenshot-menu.png" />
<img src="doc/screenshot-png.png" />

[How to use]<br/>

1.<b>setup environment</b><br/>
    install android SDK (at least "Platform Tools" which include adb).<br/>
    install android USB driver automatically or manually.<br/>
    install node.js manually (<a href="http://nodejs.org/download/">download</a>).<br/>
    $> cd path_of_this_project/bin<br/>

3.<b>start stream server</b><br/>
    connect your android smart phone to PC/Mac by usb cable or set WiFi debug mode by adb tcp command.<br/>
    $> cd path_of_this_project/bin<br/>
    $> node stream.js<br/>

    to show help: node stream.js --help

4.<b>show webm video/animated png in menu page: http://localhost:3000/</b><br/>
for webm video, recommend chrome browser.<br/>
<br/>
    or embed video into your html page:<br/>
    &lt;video controls preload="none" autobuffer="false"&gt;<br/>
	    &lt;source src="http://localhost:3000/capture?device=yourDeviceSerialNumber&type=webm&fps=4" type="video/webm"><br/>
    &lt;/video&gt;<br/>

    or embed animated png into your html page:<br/>
    &lt;img src="http://localhost:3000/capture?device=yourDeviceSerialNumber&type=png&fps=4" /&gt;<br/>

    or to show static png:<br/>
    &lt;img src="http://localhost:3000/capture?device=yourDeviceSerialNumber&type=png&fps=0" /&gt;<br/>

[Note]<br/>
    Currently tested in android 4.2, 4.1, 4.0, 2.2, 2.3.<br/>
    Host OS can be Windows/Mac/Linux (Unix should also be OK, but not tested).<br/>
    src/build_all.sh has been tested in Mac OS X 10.7 64bit and Ubuntu 12 64bit.
    Android NDK r8 or r9. Gcc 4.4.3 or 4.8 

[Todo]<br/>
    enhance performance!<br/>
    many many...
