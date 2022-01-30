// @ts-check

const path = require('path');
const fs = require('fs');
const xml2js = require('xml2js');
const del = require('del');
const deleteEmpty = require('delete-empty');

const { series, parallel, src, dest } = require('gulp');
const zip = require('gulp-zip');
const concat = require('gulp-concat');
const terser = require('gulp-terser');
const babel = require('gulp-babel');

const { spawn } = require('child_process');

const request = require('request');

const packageJson = require('./package.json');
let zipName = `${packageJson.packageName}-min-${packageJson.version}.zip`;

const subProjects = {
    'BMCoreUI': '../BMCoreUI',
    'BMCollectionView': '../BMCollectionViewTypescript',
    'BMCodeHost': '../BMCodeHost',
    'BMMenu': '../BMMenu',
    'BMPresentationController': '../BMPresentationController',
    'BMView': '../BMView'
}

function zipNameDebug(cb) {
    zipName = `${packageJson.packageName}-dev-${packageJson.version}.zip`;
    cb();
}

/**
 * Cleans the build directory.
 */
async function cleanBuildDir() {
    await del('build');
    await del('zip');

    fs.mkdirSync('build');
    fs.mkdirSync('build/ui');
    fs.mkdirSync('build/ui/BMCoreUIWidgets');
    fs.mkdirSync('zip');
}

/**
 * Builds all subprojects.
 */
async function buildAll() {
    await buildAllWithCommand('build');
}

/**
 * Builds all subprojects without optimization.
 */
async function buildAllDebug() {
    await buildAllWithCommand('buildDebug');
}

async function buildAllWithCommand(command) {
    // Build core ui first, if specified
    for (const key in subProjects) {
        if (key == 'BMCoreUI') {
            console.log(`Building sub-project ${key}...`);
            await new Promise(resolve => {
                spawn('npm', ['run', command], {cwd: subProjects[key], stdio: 'inherit', shell: true}).on('close', resolve);
            });
            break;
        }
    }

    // Then build everything else in parallel
    const promises = [];
    for (const key in subProjects) {
        if (key == 'BMCoreUI') continue;

        console.log(`Building sub-project ${key}...`);
        promises.push(new Promise(resolve => {
            spawn('npm', ['run', command], {cwd: subProjects[key], stdio: 'inherit', shell: true}).on('close', resolve);
        }));
    }

    await Promise.all(promises);
}

/**
 * Copies the files from all subprojects into the build folder.
 * Also copies the metadata.xml file into the build folder.
 */
async function copyAll() {
    const folders = Object.keys(subProjects).map(key => `${subProjects[key]}/build/ui/${key}/**/*`);

    await new Promise(resolve => src(folders).pipe(dest('build/ui/BMCoreUIWidgets')).on('end', resolve));

    await new Promise(resolve => src('metadata.xml').pipe(dest('build/').on('end', resolve)));
}

/**
 * Merges the subproject files into a single file per type. The order is determined by the key order in the `subProjects` map and then the file
 * order as defined in the metadata xml file.
 */
async function mergeAll() {

    const metadataKeys = Object.keys(subProjects);
    const metadataXMLs = await Promise.all(metadataKeys.map(key => `${subProjects[key]}/build/metadata.xml`).map(file => fs.readFileSync(file, 'utf8')).map(xml => xml2js.parseStringPromise(xml)));

    const metadatas = metadataKeys.map((k, i) => ({key: k, xml: metadataXMLs[i]}));

    const IDEJS = [], IDECSS = [], runtimeJS = [], runtimeCSS = [];

    // Run through each of the metadata defined files and add their contents to the specific groups
    for (const metadata of metadatas) {
        for (const fileResource of metadata.xml.Entities.Widgets[0].Widget[0].UIResources[0].FileResource) {
            /** @type {string} */ let filename = fileResource.$.file;
            // Webpack bundles are renamed upon zipping, so they don't match their metadata names in the build folder
            if (filename.endsWith('ide.bundle.js')) filename = 'widgetIde.bundle.js';
            if (filename.endsWith('runtime.bundle.js')) filename = 'widgetRuntime.bundle.js';

            fileResource.content = fs.readFileSync(`${subProjects[metadata.key]}/build/ui/${metadata.key}/${filename}`, 'utf8');

            // The file will have been moved into the build folder by the copy all action, but it is no longer needed
            await del(`build/ui/BMCoreUIWidgets/${filename}`);

            // TODO: Replace references to extension specific folders
            const extensionPackageName = metadata.xml.Entities.ExtensionPackages[0].ExtensionPackage[0].$.name;
            fileResource.content = fileResource.content.replace(new RegExp(`Common\\/extensions\\/${extensionPackageName}\\/ui\\/${metadata.key}`, 'g'), 'Common/extensions/BMCoreUIWidgets/ui/BMCoreUIWidgets')
            
            // Note that while the type is fixed, a file can be both a development and runtime resource, but only has a single type
            if (fileResource.$.isDevelopment == 'true') {
                if (fileResource.$.type == 'CSS') {
                    IDECSS.push(fileResource.content);
                }
                else {
                    IDEJS.push(fileResource.content);
                }
            }

            if (fileResource.$.isRuntime == 'true') {
                if (fileResource.$.type == 'CSS') {
                    runtimeCSS.push(fileResource.content);
                }
                else {
                    runtimeJS.push(fileResource.content);
                }
            }
        }
    }

    // The JS resources are wrapped in an IIFE
    IDEJS.unshift('\n;(function() {\n');
    IDEJS.push('\n})();\n');

    runtimeJS.unshift('\n;(function() {\n');
    runtimeJS.push('\n})();\n');

    // Combine and write out the files
    fs.writeFileSync('build/ui/BMCoreUIWidgets/ide.css', IDECSS.join('\n'), 'utf8');
    fs.writeFileSync('build/ui/BMCoreUIWidgets/runtime.css', runtimeCSS.join('\n'), 'utf8');
    fs.writeFileSync('build/ui/BMCoreUIWidgets/ide.js', IDEJS.join('\n'), 'utf8');
    fs.writeFileSync('build/ui/BMCoreUIWidgets/runtime.js', runtimeJS.join('\n'), 'utf8');

}

async function createZip() {

    // Create a zip of the build directory
    const zipStream = src('build/**')
        .pipe(zip(zipName))
        .pipe(dest('zip'));

    await new Promise(resolve => zipStream.on('end', resolve));
}

async function upload() {
    const host = packageJson.thingworxServer;
    const user = packageJson.thingworxUser;
    const password = packageJson.thingworxPassword;

    return new Promise((resolve, reject) => {
        request.post({
            url: `${host}/Thingworx/Subsystems/PlatformSubsystem/Services/DeleteExtensionPackage`,
            headers: {
                'X-XSRF-TOKEN': 'TWX-XSRF-TOKEN-VALUE',
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-THINGWORX-SESSION': 'true'
            },
            body: {packageName: packageJson.packageName},
            json: true
        },
        function (err, httpResponse, body) {
            // load the file from the zip folder
            let formData = {
                file: fs.createReadStream(
                    path.join('zip', zipName)
                )
            };
            // POST request to the ExtensionPackageUploader servlet
            request
                .post(
                    {
                        url: `${host}/Thingworx/ExtensionPackageUploader?purpose=import`,
                        headers: {
                            'X-XSRF-TOKEN': 'TWX-XSRF-TOKEN-VALUE'
                        },
                        formData: formData
                    },
                    function (err, httpResponse, body) {
                        if (err) {
                            console.error("Failed to upload widget to thingworx");
                            reject(err);
                            return;
                        }
                        if (httpResponse.statusCode != 200) {
                            reject(`Failed to upload widget to thingworx. We got status code ${httpResponse.statusCode} (${httpResponse.statusMessage})
                            body:
                            ${httpResponse.body}`);
                        } else {
                            console.log(`Uploaded widget version ${packageJson.version} to Thingworx!`);
                            resolve();
                        }
                    }
                )
                .auth(user, password);

            if (err) {
                console.error("Failed to delete widget from thingworx");
                return;
            }
            if (httpResponse.statusCode != 200) {
                console.log(`Failed to delete widget from thingworx. We got status code ${httpResponse.statusCode} (${httpResponse.statusMessage})
                body:
                ${httpResponse.body}`);
            } else {
                console.log(`Deleted previous version of ${packageJson.packageName} from Thingworx!`);
            }
        })
        .auth(user, password);
    })
}

exports.default = series(cleanBuildDir, buildAll, copyAll, mergeAll, createZip);
exports.buildDebug = series(zipNameDebug, cleanBuildDir, buildAllDebug, copyAll, mergeAll, createZip);
exports.merge = series(cleanBuildDir, copyAll, mergeAll, createZip);

exports.upload = series(cleanBuildDir, buildAll, copyAll, mergeAll, createZip, upload);
exports.uploadDebug = series(zipNameDebug, cleanBuildDir, buildAllDebug, copyAll, mergeAll, createZip, upload);