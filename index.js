var through = require('through2');
var gutil = require('gulp-util');
var PluginError = gutil.PluginError;
var Q = require('q');
var azure = require('azure');
var mime = require('mime');
var path = require('path');
var zlib = require('zlib');
var fs = require('fs');


const PLUGIN_NAME = 'gulp-deploy-azure-cdn ';

function prefixStream(prefixText) {
    var stream = through();
    stream.write(prefixText);
    return stream;
}

module.exports = function (options) {
    options = options || {
        serviceOptions: [], // custom arguments to azure.createBlobService
        containerName: null, // container name, required
        containerOptions: {publicAccessLevel: "blob"}, // container options
        cwd: '', // path within container
        deleteExistingBlobs: true, // true means recursively deleting anything under cwd
        concurrentUploadThreads: 10, // number of concurrent uploads, choose best for your network condition
        gzip: false, // gzip files if they become smaller after zipping, content-encoding header will change if file is zipped
        metadata: {cacheControl: 'public, max-age=31556926'}, // metadata for each uploaded file
        testRun: false // test run - means no blobs will be actually deleted or uploaded, see log messages for details
    };
    if (!options.containerName) {
        throw PluginError(PLUGIN_NAME, "Missing containerName!");
    }
    var blobService = azure.createBlobService.apply(azure, options.serviceOptions);

    // first create container and clean content
    function createContainer() {
        var deferred = Q.defer();
        blobService.createContainerIfNotExists(options.containerName, options.containerOptions, function (err) {
            if (err) {
                if (err.code === 'ContainerBeingDeleted') {
                    throw PluginError(PLUGIN_NAME, "Container being deleted, retry in 10 seconds");
                }
                throw PluginError(PLUGIN_NAME, err);
            }
            deferred.resolve();
        });
        return deferred.promise;
    }

    function noop() {
        var success = arguments[arguments.length - 1];
        success();
    }

    function emptyTargetFolder() {
        var deferred = Q.defer();
        if(options.deleteExistingBlobs){
            deferred.resolve();
        } else {
            // removing all blobs in destination structure
            blobService.listBlobs(options.containerName, {prefix: options.cwd}, function (err, blobs) {
                if (err) {
                    throw PluginError(PLUGIN_NAME, err);
                }
                var count = blobs.length;
                blobs.forEach(function (blob, next) {
                    gutil.log(PLUGIN_NAME + " deleting file " + blob.name);
                    var exec = options.testRun ? noop : blobService.deleteBlob;
                    exec.call(blobService, options.containerName, blob.name, function (err, success) {
                        if (err) {
                            gutil.log(PLUGIN_NAME + " Error while deleting blob " + blob.name);
                            throw PluginError(PLUGIN_NAME, err);
                        }
                        gutil.log(PLUGIN_NAME + " deleted " + blob.url);
                        if(--count == 0){
                            deferred.resolve();
                        }
                    });
                });

            });
        }
        return deferred.promise;
    }
    var preparation = createContainer().
        then(emptyTargetFolder);

    return through.obj(function (file, enc, cb) {
        var self = this;

        if (path.basename(file.path)[0] === '_') {
            return cb();
        }

        if (file.isNull()) {
            this.push(file);
            return cb();
        }

        if (file.isStream()) {
            this.emit('error', new gutil.PluginError(PLUGIN_NAME, 'Streaming not supported'));
            return cb();
        }

        console.log(file);

        var destFileName = options.cwd + file.name;
        var sourceFile = file.name;
        var metadata = clone(options.metadata);
        metadata.contentType = mime.lookup(sourceFile);
        if(options.zip){
            preparation.then(gzipFile(sourceFile))
                .then(function (tmpFile) {
                    return chooseSmallerFileAndModifyContentType(tmpFile, sourceFile, metadata);
                })
                .then(function (res) {
                    gutil.log(PLUGIN_NAME, "Based on file size decided to upload", res.fileToUpload, "with contentEncoding", res.updatedMetadata.contentEncoding);
                    return uploadFileToAzureCdn(options.containerName, destFileName, res.fileToUpload, res.updatedMetadata)
                        .finally(function(){
                            fs.unlinkSync(res.zippedTmpFile);
                        });
                }).then(function(){
                    cb();
                })
        } else {
            preparation.then(uploadFileToAzureCdn(options.containerName, destFileName, sourceFile, metadata)).then(
                function() {
                    cb();
                }
            )
        }

        function uploadFileToAzureCdn(containerName, destFileName, sourceFile, metadata) {
            var deferred = Q.defer();
            var exec = options.testRun ? noop : blobService.createBlockBlobFromFile;
            exec.call(blobService, containerName, destFileName, sourceFile, metadata, function(err) {
                if (err) {
                    self.emit('error', new gutil.PluginError(PLUGIN_NAME, err));
                    return cb();
                }
                gutil.log(PLUGIN_NAME, "Uploaded file", destFileName, "to", containerName);
                deferred.resolve();
            });
            return deferred.promise;
        }

        function chooseSmallerFileAndModifyContentType(compressedFile, originalFile, metadata) {
            var deferred = Q.defer();
            fs.stat(compressedFile, function (err, compressedStats) {
                if(err){
                    deferred.reject(err);
                    return;
                }
                fs.stat(originalFile, function (err, originalStats) {
                    if(err){
                        deferred.reject(err);
                        return;
                    }
                    if(originalStats.size < compressedStats.size){
                        // don't upload compressed if it becomes bigger
                        deferred.resolve({
                            zippedTmpFile: compressedFile,
                            fileToUpload: originalFile,
                            updatedMetadata: metadata
                        });
                    } else {
                        metadata.contentEncoding =  'gzip';
                        deferred.resolve({
                            zippedTmpFile: compressedFile,
                            fileToUpload: compressedFile,
                            updatedMetadata: metadata
                        });
                    }
                });

            });
            return deferred.promise;
        }

        function gzipFile(source){
            var tempFile;
            var deferred = Q.defer(),
                gzip = zlib.createGzip({
                    level: 9 // maximum compression
                }),
                inp,
                out;

            gzip.on('error', function(err) {
                gutil.log(PLUGIN_NAME, err);
                deferred.reject(err);
            });

            inp = fs.createReadStream(source);
            tempFile = source + '.zip';
            out = fs.createWriteStream(tempFile);
            out.on('close', function() {
                deferred.resolve(tempFile);
            });
            inp.pipe(gzip).pipe(out);
            return deferred.promise;
        }

        function clone(obj) {
            if (null == obj || "object" != typeof obj) return obj;
            var copy = obj.constructor();
            for (var attr in obj) {
                if (obj.hasOwnProperty(attr)) copy[attr] = obj[attr];
            }
            return copy;
        }

    });
};