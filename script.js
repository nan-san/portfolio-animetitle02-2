// Object type definitions
var AN_TYPE_OBJECT_COMPOSITION = 1000;
var AN_TYPE_OBJECT_IMAGE = 1001;
var AN_TYPE_OBJECT_VIDEO = 1002;
var AN_TYPE_OBJECT_SHAPE = 1003;
var AN_TYPE_OBJECT_TEXT  = 1004;
var AN_TYPE_OBJECT_SOUND = 1005;
var AN_TYPE_OBJECT_DUMMY = 1006;

var AN_GRADIENT_TYPE_LINEAR = 0;
var AN_GRADIENT_TYPE_RADIAL = 1;

var startTime = 0;
var currentTime = 0;
var nestedCompositions = []; // Current stack of nested composition objects
var nestedCompositionOffset = 0;
   
var mediaToLoad = 0; // Number of media files to load.
var mediaReady = 0; // Number of media files successfully loaded.
var mediaSkip = false; // When this is true all media objects are skipped and not rendered.
var currentLoop = 0; // Number of times we played the composition till the end.

function getDistanceBetweenPoints(x1, y1, x2, y2) {
   var dx = x2 - x1;
   var dy = y2 - y1;
   return Math.sqrt((dx * dx) + (dy * dy));
}

function getGradient(ctx, gradient, bounds) { // This function is related to the method ANGradient::GetBrush()
   var from = gradient.from;
   var to = gradient.to;

   var boundsWidth = bounds.right - bounds.left;
   var boundsHeight = bounds.bottom - bounds.top;

   var startPointX = bounds.left + boundsWidth * from[0];
   var startPointY = bounds.top + boundsHeight * from[1];

   var scale = 1; // For the linear gradient the scaling of the positions does not change
   var grd;
   if (gradient.type == AN_GRADIENT_TYPE_LINEAR) {
      grd = ctx.createLinearGradient(startPointX, startPointY, bounds.left + boundsWidth * to[0], bounds.top + boundsHeight * to[1]);
   } else {
      // Calculate the radial gradient extent depending on the point from
      //  -Move coordinates from [0; 1] to [-0.5; 0.5]
      //  -Calculate the position of the point and replace it in the positive quarter
      //  -Calculate the distance between found point and [-0.5; -0.5]
      var extent = getDistanceBetweenPoints(Math.abs(from[0] - 0.5), Math.abs(from[1] - 0.5), -0.5, -0.5);
      scale = getDistanceBetweenPoints(from[0], from[1], to[0], to[1]) / extent;
      grd = ctx.createRadialGradient(startPointX, startPointY, 0, startPointX, startPointY, (boundsWidth > boundsHeight) ? boundsWidth * extent : boundsHeight * extent);
   }

   var stops = gradient.stops;
   for (var i = 0; i < stops.length; i++) {
      grd.addColorStop(stops[i].position * scale, stops[i].color);
   }
   return grd;
}

function applyGradientTransformation(ctx, gradientType, width, height) { // Apply transformation to get the object of the correct scale for radial gradient and do nothing
   if ((gradientType == AN_GRADIENT_TYPE_RADIAL) && (width != height)) {
      if (width > height) {
         ctx.scale(1, height / width);
      } else {
         ctx.scale(width / height, 1);
      }
   }
}

function getGradientBounds(gradientType, bounds) { // Stretch bounding box of the object to a square for radial gradient and do nothing for linear
   var gradientBounds = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
   if (gradientType == AN_GRADIENT_TYPE_RADIAL) {
      var boundsWidth = gradientBounds.right - gradientBounds.left;
      var boundsHeight = gradientBounds.bottom - gradientBounds.top;
      if (boundsWidth > boundsHeight) {
         gradientBounds.top *= boundsWidth / boundsHeight;
         gradientBounds.bottom = gradientBounds.top + boundsWidth;
      } else {
         gradientBounds.left *= boundsHeight / boundsWidth;
         gradientBounds.right = gradientBounds.left + boundsHeight;
      }
   }
   return gradientBounds;
}

function clearCanvas(ctx) { // Clear canvas with the background color or gradient.
   ctx.setTransform(1, 0, 0, 1, 0, 0);
   ctx.globalAlpha = 1.0;
   
   var color = project.active().color;
   var gradient = project.active().gradient;
   if ((gradient == null) && (color == null)) { // If neither the color nor the gradient is specified, the background is off and must be transparent
      ctx.clearRect(0, 0, project.width, project.height); // It is necessary, otherwise all the frames on the canvas remain
      return;
   }
   
   ctx.save(); // Keep the state of the context, since with radial gradient, it may be necessary to change the transform matrix
   if (color != null) {
      ctx.fillStyle = color;
   }
   var width = project.width;
   var height = project.height;
   if (gradient != null) {
      // The radial gradient can only be drawn in a strictly round shape.
      // Therefore, to get an elliptical shape, need to stretch the bounding box of the object to a square(getGradientBounds)
      // and apply transformation(applyGradientTransformation) to get the object of the correct scale.
      applyGradientTransformation(ctx, gradient.type, project.width, project.height);
      var bounds  = { left: 0, top: 0, right: width, bottom: height };
      var gradientBounds = getGradientBounds(gradient.type, bounds);
      ctx.fillStyle = getGradient(ctx, project.active().gradient, gradientBounds);

      width = gradientBounds.right - gradientBounds.left;
      height = gradientBounds.bottom - gradientBounds.top;
   }
   ctx.fillRect(0, 0, width, height);
   ctx.restore();
}

function findKeys(animation, position) { // Finds 2 keys to use for interpolation at the specified position in the animation.
   var keys = { left: -1, right: -1 };
   for (var i = 0; i < animation.length; i++) {
      if (animation[i].time <= position) keys.left = i;
      if (animation[i].time >= position) {
         if (keys.left == -1) keys.left = i;
         keys.right = i;
         break;
      }
   }
   return keys;
}

function linear(animation, position, keys) { // Perform linear interpolation of 2 keys for the specified position in the animation.
   var result = [];
   for (var n = 0; n < animation[keys.left].value.length; n++) {
      result[n] = (animation[keys.right].value[n] * (position - animation[keys.left].time) + animation[keys.left].value[n] * (animation[keys.right].time - position)) / (animation[keys.right].time - animation[keys.left].time);
   }
   return result;
}

function createControlPoint(key, name) {
   if (key.hasOwnProperty(name)) return;
   key[name] = { };
   key[name]["time"] = 0;
   key[name]["value"] = [ ];
   for (var n = 0; n < key.value.length; n++) key[name].value.push(0);
}

function getValue(animation, position) { // Returns a value of the animation for the specified position.
   if (animation.length == 0) return; // Error: animation must always have at least 1 key.
   position -= nestedCompositionOffset;

   var keys = findKeys(animation, position);
   if ((keys.right == -1) || (animation[keys.left].time == animation[keys.right].time)) return animation[keys.left].value;

   // Create control points if necessary
   createControlPoint(animation[keys.left], "cp1");
   createControlPoint(animation[keys.left], "cp2");
   createControlPoint(animation[keys.right], "cp1");
   createControlPoint(animation[keys.right], "cp2");

   // Use linear interpolation if the Bezier curve has default control points.
   var isBezier = false;
   for (var n = 0; n < animation[keys.left].cp2.value.length; n++) {
      if ((animation[keys.left].cp2.value[n] != 0) || (animation[keys.right].cp1.value[n] != 0)) {
         isBezier = true;
         break;
      }
   }
   if (!isBezier) return linear(animation, position, keys);

   // Perform interpolation along a Bezier curve.
   // Assume there's exactly 1 'y' value for every given 'x' in our Bezier curve.
   // Find the 't' parameter for the given position using binary search.
   var nIterations = 0; // Used to make sure there are not too many iterations.
   var tMin = 0.0;
   var tMax = 1.0;
   var t = 0.5; // Initial guess for 't', could be some other arbitrary value.
   do {
      var dLeftControlPoint = animation[keys.left].time + animation[keys.left].cp2.time;
      var dRightControlPoint = animation[keys.right].time + animation[keys.right].cp1.time;

      var dX = (Math.pow(1.0 - t, 3) * animation[keys.left].time) + (3.0 * t * Math.pow(1.0 - t, 2) * dLeftControlPoint) + (3 * Math.pow(t, 2) * (1.0 - t) * dRightControlPoint) + (Math.pow(t, 3) * animation[keys.right].time);
      if (dX == position) break;
      if (position > dX) {
         if (tMin == t) break; // We're already at the minimum, but the position seems to be larger.
         tMin = t;
         t += (tMax - t) / 2.0;
      } else {
         if (tMax == t) break; // We're already at the maximum, but the position seems to be smaller.
         tMax = t;
         t -= (t - tMin) / 2.0;
      }

      nIterations++;
      if (nIterations >= 4 * 8) { // The number of iterations can't be more than the number of data bits (sizeof(double) * 8)
         // Error: Couldn't find a solution
         break;
      }
   } while (true);

   // We found our 't' parameter. Now we can calculate the 'y' value at the given position.
   var result = [];
   for (var n = 0; n < animation[keys.left].value.length; n++) {
      var leftValue = animation[keys.left].value[n] + animation[keys.left].cp2.value[n];
      var rightValue = animation[keys.right].value[n] + animation[keys.right].cp1.value[n];
      result[n] = (Math.pow(1.0 - t, 3) * animation[keys.left].value[n]) + (3.0 * t * Math.pow(1.0 - t, 2) * leftValue) + (3 * Math.pow(t, 2) * (1.0 - t) * rightValue) + (Math.pow(t, 3) * animation[keys.right].value[n]);
   }
   return result;
}

function getSingleValue(animation, position) {
   if (animation.length == 0) return; // Error: animation must always have at least 1 key.
   position -= nestedCompositionOffset;
   var keys = findKeys(animation, position);
   return animation[keys.left].value;
}

function applyActiveCompositionMatrix(ctx) { // Apply a transformation to convert from composition to the canvas frame coordinate system.
   var compositionAspect = project.active().aspect;
   var frameAspect = project.width / project.height;
   var canvasSize = { width: project.width, height: project.height };
   if (compositionAspect >= frameAspect) canvasSize.height = project.width / compositionAspect;
   else canvasSize.width = canvasSize.height * compositionAspect;
   // See ANMatrix::TransformCompositionToFrame()
   ctx.scale(canvasSize.width / compositionAspect, canvasSize.height);
   ctx.translate(compositionAspect / 2.0, 0.5);
}

function applyNestedCompositionMatrix(ctx, bClip) {
   for (var i = 0; i < nestedCompositions.length; i++) {
      applyTransform(ctx, nestedCompositions[i].transform);
      var aspect = project.compositions[nestedCompositions[i].composition].aspect;
      if (aspect > 1.0) ctx.scale(1.0 / aspect, 1.0 / aspect);
      
      if (bClip) {
         ctx.beginPath();
         ctx.lineWidth = 1 / 10000.0; // Set the minimum possible stroke line width (see COMPOSITION_MAX_RESOLUTION)
         ctx.rect(-aspect / 2.0, -0.5, aspect, 1.0);
         ctx.clip();
      }
   }
}

function findObjectByID(id) { // Returns an object with the specified id
   for (var c = 0; c < project.compositions.length; c++) {
      var active = project.compositions[c];
      for (var i = 0; i < active.objects.length; i++) {
         if (active.objects[i].id == id) return active.objects[i];
      }
   }
   return null;
}

function applyTransform(ctx, transform) { // Apply object's transformation matrix for the specified position to the canvas.
   var position = currentTime;
   if (transform.hasOwnProperty("parent")) applyTransform(ctx, findObjectByID(transform.parent).transform, position); // Apply parent transformation.
   var ptAnchor = getValue(transform.anchor, position);
   var ptPosition = getValue(transform.position, position);
   var ptScale = getValue(transform.scale, position);
   var dAngle = getValue(transform.rotation, position);
   ctx.translate(ptPosition[0], ptPosition[1]);
   ctx.rotate((dAngle[0] * Math.PI) / 180);
   ctx.scale(ptScale[0], ptScale[1]);
   ctx.translate(-ptAnchor[0], -ptAnchor[1]);
}

function valueToColor(color) { // Converts animated value returned by getValue() to a color string.
   return "#" + ((1 << 24) + (Math.round(color[0] * 255) << 16) + (Math.round(color[1] * 255) << 8) + Math.round(color[2] * 255)).toString(16).slice(1);
}

function drawObjectNoMask(ctx, object) { // Draw an object without mask
   if ((object.type == AN_TYPE_OBJECT_DUMMY) || (object.type == AN_TYPE_OBJECT_SOUND)) return;
   
   var position = currentTime;
   if (object.hasOwnProperty("transform")) { // Apply object transformation
      applyTransform(ctx, object.transform);
   } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0); // Don't use transformation matrix for this object.
   }
   ctx.globalAlpha = getValue(object.opacity, position)[0];
   
   // Draw the object
   switch (object.type) {
      case AN_TYPE_OBJECT_SHAPE: if (object.hasOwnProperty("shape")) drawShape(ctx, object.shape); break;
      case AN_TYPE_OBJECT_TEXT: if (object.hasOwnProperty("text")) drawText(ctx, object.text); break;
      case AN_TYPE_OBJECT_IMAGE:
      case AN_TYPE_OBJECT_VIDEO: drawBitmap(ctx, object); break;
      case AN_TYPE_OBJECT_COMPOSITION: {
         var composition = project.compositions[object.composition];
         nestedCompositions.push(object);
         nestedCompositionOffset += object.start;
         drawObjects(ctx, composition.objects);
         nestedCompositionOffset -= object.start;
         nestedCompositions.pop();
      } break;
   }
}

function drawObjectNoEffect(ctx, object) { // Draws an object with masks but no effects
   ctx.save();
   applyActiveCompositionMatrix(ctx);
   applyNestedCompositionMatrix(ctx, true);
   if (object.hasOwnProperty("mask")) { // Render object with a mask applied
      var tempCanvas = document.createElement('canvas'); // TODO: Create this canvas once per nested composition
      var tempContext = tempCanvas.getContext('2d');
      tempCanvas.width = ctx.canvas.width;
      tempCanvas.height = ctx.canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      applyActiveCompositionMatrix(tempContext);
      applyNestedCompositionMatrix(tempContext, true);
      for (var i = 0; i < object.mask.length; i++) {
         tempContext.save();
         drawObjectNoMask(tempContext, object); // Render object without a mask into temporary canvas
         drawMask(tempContext, object, object.mask[i]); // Apply masks to the object
         ctx.drawImage(tempCanvas, 0, 0); // Render temporary canvas (object with mask applied) back to the main canvas
         tempContext.restore();
      }
   } else {
      drawObjectNoMask(ctx, object);
   }
   ctx.restore();
}

function drawObject(ctx, object) { // Draws an object with masks and effects applied
   ctx.save();
   ctx.setTransform(1, 0, 0, 1, 0, 0);
   if (object.hasOwnProperty("effect")) {
      var tempCanvas = document.createElement('canvas'); // TODO: Create this canvas once per nested composition
      var tempContext = tempCanvas.getContext('2d');
      tempCanvas.width = ctx.canvas.width;
      tempCanvas.height = ctx.canvas.height;
      drawObjectNoEffect(tempContext, object);
      drawEffects(tempContext, object);
      ctx.drawImage(tempCanvas, 0, 0);
   } else {
      drawObjectNoEffect(ctx, object);
   }
   ctx.restore();
}

function drawObjects(ctx, objects) {
   var position = currentTime;
   for (var i = 0; i < objects.length; i++) {
      var object = objects[i];
      if (mediaSkip && ((object.type == AN_TYPE_OBJECT_VIDEO) || (object.type == AN_TYPE_OBJECT_SOUND))) continue; // Skip media objects
      var objectStart = nestedCompositionOffset + object.start;
      var objectEnd = nestedCompositionOffset + object.stop;
      if (object.type == AN_TYPE_OBJECT_COMPOSITION) {
         objectStart += object.inpoint;
         objectEnd += object.inpoint;
      }
      if ((position < objectStart) || (position >= objectEnd)) continue; // Object is invisible at the current position.
      drawObject(ctx, object);
      if (object.hasOwnProperty("isFullscreen") && (object.isFullscreen == true)) break; // This is a fullscreen cache object, no need to render any other objects.
   }
}

function drawBitmap(ctx, object) { // Draws a bitmap object
   var position = currentTime;
   ctx.save();
   
   if (object.hasOwnProperty("sourceMatrix")) ctx.transform(object.sourceMatrix[0], object.sourceMatrix[1], object.sourceMatrix[2], object.sourceMatrix[3], object.sourceMatrix[4], object.sourceMatrix[5]);
   else ctx.setTransform(1, 0, 0, 1, 0, 0);
   
   var objectImage = document.getElementById(object.id);
   if (object.type == AN_TYPE_OBJECT_VIDEO && object.hasOwnProperty("isAlphaStacked") && (object.isAlphaStacked == true)) { // Check if this object has a video of the alpha channel stacked vertically
      var alphaCanvas = document.createElement('canvas');
      var alphaContext = alphaCanvas.getContext('2d');

      var width = objectImage.videoWidth;
      var height = objectImage.videoHeight / 2;

      alphaCanvas.width = width;
      alphaCanvas.height = height * 2;
      alphaContext.drawImage(objectImage, 0, 0);
      
      // This can be done without alphaData, except in Firefox which doesn't like it when image is bigger than the canvas
      var image = alphaContext.getImageData(0, 0, width, height);
      var imageData = image.data;
      var alphaData = alphaContext.getImageData(0, height, width, height).data;
      
      for (var i = 3; i < imageData.length; i = i + 4) imageData[i] = alphaData[i - 1]; // Copy alpha values over

      // For some reason reusing the same context: "alphaContext.putImageData(image, 0, 0, 0, 0, width, height)" sometimes draws an invalid line at the bottom of the image.
      var imageCanvas = document.createElement('canvas');
      var imageContext = imageCanvas.getContext('2d');
      imageCanvas.width = width;
      imageCanvas.height = height;
      imageContext.putImageData(image, 0, 0, 0, 0, width, height);
      ctx.drawImage(imageCanvas, 0, 0, width, height, 0, 0, width, height);
   } else { // There's no stacked alpha, just draw the image normally
      ctx.drawImage(objectImage, 0, 0);
   }
   ctx.restore();
}

function cueVideo(objects) { }
function cueAudio(objects) { }

function loadMedia() { // There's no media, so just start rendering immediately
   startTime = (new Date()).getTime();
   setTimeout(renderFrame, 0); // Postpone executing the function to avoid endless recursion when looping animation continously.
}

var AN_MASK_FEATHER_SCALE = 2.0;
var AN_BEZIER_CURVE_PARAMETER_STEP = 0.01; // In a Bezier curve segment parameter goes through the range [0..1] with the specified step 0.01

function drawVertexList(ctx, vertexList) { // Draw the animated vertex list for the specified position.
   var position = currentTime;
   var startPoint = getValue(vertexList[0].v, position);
   ctx.beginPath();
   ctx.moveTo(startPoint[0], startPoint[1]);
   for (var j = 0; j < vertexList.length - 1; j++) {
     var vertex = vertexList[j];
     var vertexNext = vertexList[j + 1];
     var cp1 = getValue(vertex.cn, position);
     var cp2 = getValue(vertexNext.cp, position);
     var vend = getValue(vertexNext.v, position);
     ctx.bezierCurveTo(cp1[0], cp1[1], cp2[0], cp2[1], vend[0], vend[1]);
   }
   vertex = vertexList[vertexList.length - 1];
   cp1 = getValue(vertex.cn, position);
   cp2 = getValue(vertexList[0].cp, position);
   ctx.bezierCurveTo(cp1[0], cp1[1], cp2[0], cp2[1], startPoint[0], startPoint[1]);
}

function getCurvePointCoordinate(t, start, control1, control2, end) {
   return (Math.pow(1.0 - t, 3.0) * start) + (3.0 * t * Math.pow(1.0 - t, 2.0) * control1) + (3.0 * Math.pow(t, 2.0) * (1.0 - t) * control2) + (Math.pow(t, 3.0) * end);
}

function expandToInclude(bounds, x, y) {
   if (x < bounds.left) bounds.left = x;
   if (x > bounds.right) bounds.right = x;
   if (y < bounds.top) bounds.top = y;
   if (y > bounds.bottom) bounds.bottom = y;
}

function getBounds(vertexList, strokeWidth, position) { // The algorithm is the same as in the function ANPropertyShapePath::GetBounds()
   var strokeHalfWidth = getValue(strokeWidth, position)[0] / 2.0;
   var isLastPoint = false;
   var pt = getValue(vertexList[0].v, position);
   var bounds  = { left: pt[0], top: pt[1], right: pt[0], bottom: pt[1] };
   
   var vertexIndex = 0;
   while (!isLastPoint) {
      var pt1 = getValue(vertexList[vertexIndex].v, position);
      var cp1 = getValue(vertexList[vertexIndex].cn, position);
      vertexIndex++;
      if (vertexIndex >= vertexList.length) { // Reset back to the first point, to add the last point
         vertexIndex = 0;
         isLastPoint = true;
      }
      var cp2 = getValue(vertexList[vertexIndex].cp, position);
      var pt2 = getValue(vertexList[vertexIndex].v, position);

      for (t = 0.0; (t < 1.0) || (t.toFixed(3) == 1.0); t += AN_BEZIER_CURVE_PARAMETER_STEP) {
         var x = getCurvePointCoordinate(t, pt1[0], cp1[0], cp2[0], pt2[0]);
         var y = getCurvePointCoordinate(t, pt1[1], cp1[1], cp2[1], pt2[1]);
         expandToInclude(bounds, x - strokeHalfWidth, y - strokeHalfWidth);
         expandToInclude(bounds, x + strokeHalfWidth, y + strokeHalfWidth);
      }
   }
   return bounds;
}

function drawShape(ctx, shape) { // Draws a shape
   var position = currentTime;

   ctx.save(); // Keep the state of the context, since with radial gradient, it may be necessary to change the transform matrix
   drawVertexList(ctx, shape.vertexList, position);

   if (shape.color != null) {
      ctx.fillStyle = valueToColor(getValue(shape.color, position));
   } else if (shape.gradient != null) {
      var bounds = getBounds(shape.vertexList, shape.strokeWidth, position);

      // The radial gradient can only be drawn in a strictly round shape.
      // Therefore, to get an elliptical shape, need to stretch the bounding box of the object to a square(getGradientBounds)
      // and apply transformation(applyGradientTransformation) to get the object of the correct scale.
      var gradient = getSingleValue(shape.gradient, position);
      applyGradientTransformation(ctx, gradient.type, bounds.right - bounds.left, bounds.bottom - bounds.top);
      ctx.fillStyle = getGradient(ctx, gradient, getGradientBounds(gradient.type, bounds));
   }

   ctx.fill("evenodd");
   ctx.restore();

   var strokeWidth = getValue(shape.strokeWidth, position)[0];
   if (strokeWidth > 0) { // Draw a shape stroke if enabled
      var strokeColor = getValue(shape.strokeColor, position);
      ctx.strokeStyle = valueToColor(strokeColor);
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
   }
}

function drawMask(ctx, object, mask) {
   var position = currentTime;
   ctx.save();
   ctx.globalAlpha = 1.0;
   ctx.globalCompositeOperation = 'destination-in';
   
   var feather = getValue(mask.feather, position)[0] * AN_MASK_FEATHER_SCALE; // Convert blur kernel size to shadowBlur value
   if (feather > 0) { // Apply mask feather
      // Render blurred shadow to simulate mask feathering
      var shadowCanvas = document.createElement('canvas'); // TODO: Create this canvas once per nested composition
      var shadowContext = shadowCanvas.getContext('2d');
      
      // Workaround for Chrome v49. Object with mask is invisible when rotation angle is close to 180.
      // Increasing the canvas size fixes the problem.
      shadowCanvas.width = ctx.canvas.width * 2;
      shadowCanvas.height = ctx.canvas.height;

      shadowContext.translate(ctx.canvas.width, 0); // Offset the actual content to make sure only the shadow is visible.
      shadowContext.shadowOffsetX = -ctx.canvas.width; // Make sure the mask is visible
      shadowContext.shadowOffsetY = 0;
      shadowContext.shadowColor = '#000';
      shadowContext.shadowBlur = feather;

      applyActiveCompositionMatrix(shadowContext);
      applyNestedCompositionMatrix(shadowContext, false);
      applyTransform(shadowContext, object.transform);

      drawVertexList(shadowContext, mask.vertexList);
      shadowContext.fill("evenodd");

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(shadowCanvas, 0, 0);
   } else {
      drawVertexList(ctx, mask.vertexList);
      ctx.fillStyle = "rgba(0, 0, 0, 255)";
      ctx.fill("evenodd");
   }
   ctx.restore();
}

// Setup onloadeddata handlers for all video objects (including nested compositions).
// Rendering doesn't start until all media files are loaded.
function loadObjectsMedia(objects) {
   for (var i = 0; i < objects.length; i++) {
      if ((objects[i].type == AN_TYPE_OBJECT_VIDEO) || (objects[i].type == AN_TYPE_OBJECT_SOUND)) {
         mediaToLoad++;
         var media = document.getElementById(objects[i].id);
         media.onloadeddata = function() {
            mediaReady++;
            if (mediaReady >= mediaToLoad) { // Start rendering after all media files have been loaded.
               startTime = (new Date()).getTime();
               renderFrame();
            }
         };
         media.load(); // Force loading of the media file
         // TODO: Add error handling.
      } else if (objects[i].type == AN_TYPE_OBJECT_COMPOSITION) {
         loadObjectsMedia(project.compositions[objects[i].composition].objects);
      }
   }
}

function renderFrame() {
   var canvas = document.getElementById("mainCanvas");
   var ctx = canvas.getContext("2d");
   currentTime = (new Date()).getTime() - startTime;
   if (currentTime >= project.active().duration) {
      currentLoop++;
      if ((project.loops != 0) && (currentLoop >= project.loops)) return; // Stop playback
      loadMedia(); // Restart playback
      return;
   }
   
   compositionList = [];
   clearCanvas(ctx);
   cueVideo(project.active().objects);
   cueAudio(project.active().objects);
   drawObjects(ctx, project.active().objects);
   requestAnimationFrame(renderFrame); // Process the next frame
}

