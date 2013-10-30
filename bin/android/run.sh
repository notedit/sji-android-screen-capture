#Because stdout will be used as video stream data, 
#so do NOT output any thing except ffmpeg data to stdout !!! 
#Any log should be write to stderr by 1>&2
echo ------------------- `date` ---------------------- 1>&2
cd ${0}_ || exit 1  #cd run.sh_ sub directory

FEED_FPS="$1"; shift || exit 1  #first argument as frames_per_second
FFMPEG_FPS="$1"; shift || exit 1  #second argument as frames_per_second
FFMPEG_OUTPUT="$@" #get all other arguments from third argument

chmod 755 * || exit 1 #set executable

echo get imageformat 1>&2

{ GET_RAW_IMG_EXEC_FILE="./get-raw-image-4.1.2"; echo trying $GET_RAW_IMG_EXEC_FILE 1>&2; IMG_FORMAT=`$GET_RAW_IMG_EXEC_FILE`; } || \
{ GET_RAW_IMG_EXEC_FILE="./get-raw-image-4"    ; echo trying $GET_RAW_IMG_EXEC_FILE 1>&2; IMG_FORMAT=`$GET_RAW_IMG_EXEC_FILE`; } || \
{ GET_RAW_IMG_EXEC_FILE="./get-raw-image-old"  ; echo trying $GET_RAW_IMG_EXEC_FILE 1>&2; IMG_FORMAT=`$GET_RAW_IMG_EXEC_FILE`; } || \
{ echo "Failed to get raw image format." 2>&1; exit 1; }

echo use imageformat: $IMG_FORMAT 1>&2
echo use GET_RAW_IMG_EXEC_FILE: $GET_RAW_IMG_EXEC_FILE 1>&2

echo test ffmpeg cpu version 1>&2
{ FFMPEG_EXEC_FILE="./ffmpeg.armv7"; echo trying $FFMPEG_EXEC_FILE 1>&2; FFMPEG_VER=`$FFMPEG_EXEC_FILE -version`; } || \
{ FFMPEG_EXEC_FILE="./ffmpeg.armv5"; echo trying $FFMPEG_EXEC_FILE 1>&2; FFMPEG_VER=`$FFMPEG_EXEC_FILE -version`; } || \
{ echo "Failed to load ffmpeg." 2>&1; exit 1; }

echo use FFMPEG_EXEC_FILE: $FFMPEG_EXEC_FILE 1>&2

FFMPEG_INPUT="-f rawvideo $IMG_FORMAT -r $FFMPEG_FPS -i -"  #intput from stdin
FFMPEG_CMDLINE="$FFMPEG_EXEC_FILE $FFMPEG_INPUT $FFMPEG_OUTPUT"

echo ****exec: "$GET_RAW_IMG_EXEC_FILE $FEED_FPS | $FFMPEG_CMDLINE"  1>&2
$GET_RAW_IMG_EXEC_FILE $FEED_FPS | $FFMPEG_CMDLINE
