#! /usr/bin/env node
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import tar from 'tar';
import AdmZip from 'adm-zip';

function parseArgs(args: string[]) {
    const obj: {
        double: {
            [key: string]: string | boolean;
        };
        single: {
            [key: string]: string | boolean;
        };
    } = {
        double: {},
        single: {},
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);

            if (key.includes('=')) {
                const [k, ...v] = key.split('=');
                obj.double[k] = v.join('=');
            } else if (args[i + 1] && !args[i + 1].startsWith('-')) {
                obj.double[key] = args[i + 1];
                i++;
            } else {
                obj.double[key] = true;
            }
        } else if (arg.startsWith('-')) {
            const key = arg.slice(1);

            if (key.includes('=')) {
                const [k, ...v] = key.split('=');
                obj.single[k] = v.join('=');
            } else if (args[i + 1] && !args[i + 1].startsWith('-')) {
                obj.single[key] = args[i + 1];
                i++;
            } else {
                obj.single[key] = true;
            }
        }
    }

    return obj;
}

function handleRes(response: http.IncomingMessage, filename: string, file: fs.WriteStream) {
    const maxLength = parseInt(response.headers['content-length'] || '0', 10);

    console.log(`Downloading ${filename} (${maxLength} bytes)`);

    let maxDownloadStatusLen = (process.stdout.columns - `Downloading ${filename}... `.length) - (3 + (`${maxLength} `.length * 2) + ' 100%'.length);

    process.stdout.on('resize', () => {
        maxDownloadStatusLen = (process.stdout.columns - `Downloading ${filename}... `.length) - (3 + (`${maxLength} `.length * 2) + ' 100%'.length);
    });

    response.pipe(file);

    response.on('data', () => {
        const progress = (file.bytesWritten / maxLength);

        process.stdout.cursorTo(0);
        process.stdout.clearLine(1);

        if (maxDownloadStatusLen < 10) {
            process.stdout.write(`Downloading ${filename}... ${Math.round(progress * 100)}% (${file.bytesWritten}/${maxLength})`);
        } else {
            process.stdout.write(`Downloading ${filename}... [${'#'.repeat(progress * maxDownloadStatusLen)}${'-'.repeat(maxDownloadStatusLen - progress * maxDownloadStatusLen)}] ${Math.round(progress * 100)}% (${file.bytesWritten}/${maxLength})`);
        }
    });
}

const args = parseArgs(process.argv.slice(2));

const { double, single } = args;

const action =
    double['download']
        ? 'download' :
        double['install']
            ? 'install' :
            double['link']
                ? 'link' :
                double['help']
                    ? 'help' :
                    double['action'] || single['a'] || 'download';

if (typeof action !== 'string') {
    console.error('Invalid action');
    process.exit(1);
}

if (![
    'download',
    'install',
    'link',
    'help'
].includes(action)) {
    console.error(`Invalid action: ${action}`);
    process.exit(1);
}

type Section = {
    keys: string[];
    description: string | (() => string);
    required?: boolean;
    default?: string;
}[];

const sections: {
    sections: Section;
    main: Section;
    download: Section;
    install: Section;
    link: Section;
} = {
    sections: [
        {
            keys: ['--help', '-h'],
            description: 'Show this help message',
        },
        {
            keys: ['--section', '-s'],
            description: () => 'Show a specific section. Can be one of: ' + Object.keys(sections).join(', '),
        },
    ],
    main: [
        {
            keys: [
                '--action',
                '-a'
            ],
            description: 'The action to perform. Can be one of download, install, link, or help',
            required: false,
            default: 'download'
        }
    ],
    download: [
        {
            keys: [
                '--build',
                '-b'
            ],
            description: 'The build to download. Can either be stable or insiders',
            required: false,
            default: 'stable'
        },
        {
            keys: [
                '--filename',
                '-f'
            ],
            description: 'The filename to download to',
            required: false,
            default: 'vscode-{build}-{platform}-{arch}.{ext (tar.gz or zip)}'
        },
        {
            keys: [
                '--download-directory',
                '-d'
            ],
            description: 'The directory the file will be downloaded to',
            required: false,
            default: 'cwd/downloads'
        }
    ],
    install: [
        {
            keys: [
                '--file',
                '-f'
            ],
            description: 'The file to install from',
            required: true
        },
        {
            keys: [
                '--insiders',
                '-i'
            ],
            description: 'Install as insiders build (this option overrides --build or -b)',
            required: false
        },
        {
            keys: [
                '--stable',
                '-s'
            ],
            description: 'Install as stable build (this option overrides --build or -b)',
            required: false
        },
        {
            keys: [
                '--build',
                '-b'
            ],
            description: 'The build to install. Can either be stable or insiders',
            required: false,
            default: 'stable'
        },
        {
            keys: [
                '--install-directory',
                '-d'
            ],
            description: 'The directory to install to',
            required: false,
            default: process.platform === 'win32'
                ? '"C:\\Program Files\\Microsoft VS Code" or "C:\\Program Files\\Microsoft VS Code Insiders"'
                : process.platform === 'darwin'
                    ? '/Applications/Visual Studio Code or /Applications/Visual Studio Code - Insiders'
                    : '/usr/share/code or /usr/share/code-insiders'
        }
    ],
    link: [
        {
            keys: [
                '--build',
                '-b'
            ],
            description: 'The build to link. Can either be stable or insiders',
            required: false,
            default: 'stable'
        },
        {
            keys: [
                '--install-directory',
                '-d'
            ],
            description: 'The directory to link from',
            required: false,
            default: process.platform === 'darwin'
                ? '/Applications/Visual Studio Code or /Applications/Visual Studio Code - Insiders'
                : '/usr/share/code or /usr/share/code-insiders'
        },
        {
            keys: [
                '--symlink-directory',
                '-s'
            ],
            description: 'The directory to link to',
            required: false,
            default: process.platform === 'linux'
                ? '/usr/bin'
                : path.join(process.env.HOME, 'bin')
        }
    ]
};

function printSection(sectionName: keyof typeof sections) {
    const section = sections[sectionName];

    console.log(sectionName);

    for (const { keys, description, required, default: def } of section) {
        console.log(`  ${keys.join(', ')}:${required ? ' (required)' : ''}${def ? ` (default: ${def})` : ''}`);

        for (const line of (
            typeof description === 'string'
                ? description
                : description()
        ).split('\n')) {
            console.log(`    ${line}`);
        }
    }

    console.log();
}

if (action === 'help') {
    const section = double['section'] || single['s'] || 'all';

    if (typeof section !== 'string') {
        console.error('Invalid section. If you want to see the sections, use --section=sections, -s=sections, or don\'t specify a section');
        process.exit(1);
    }

    switch (section) {
        case 'all':
            console.log('All sections:');
            console.log();

            for (const sectionName of Object.keys(sections)) {
                printSection(sectionName as keyof typeof sections);
            }

            break;
        case 'sections':
            printSection('sections');
            break;
        case 'main':
            printSection('main');
            break;
        case 'download':
            printSection('download');
            break;
        case 'install':
            printSection('install');
            break;
        case 'link':
            printSection('link');
            break;
        default:
            console.error(`Invalid section: ${section}`);
            process.exit(1);
    }

    process.exit(0);
} else if (action === 'download') {
    const build = double['build'] || single['b'] || 'stable';

    if (typeof build !== 'string') {
        console.error(`Invalid build: ${build}`);
        process.exit(1);
    }

    if (!['stable', 'insiders'].includes(build)) {
        console.error(`Invalid build: ${build}`);
        process.exit(1);
    }

    const os =
        process.platform === 'win32'
            ? `win32-${process.arch}-archive`
            : process.platform === 'darwin'
                ? 'darwin-universal'
                : process.platform === 'linux'
                    ? `linux-${process.arch}`
                    : 'unknown';

    if (os === 'unknown') {
        console.error(`Unsupported platform: ${process.platform}`);
        process.exit(1);
    }

    const url = `https://code.visualstudio.com/sha/download?build=${build === 'insiders' ? 'insider' : build}&os=${os}`;
    const filename = double['filename'] || single['f'] || `vscode-${build}-${os}-${Date.now()}.${process.platform === 'linux' ? 'tar.gz' : 'zip'}`;
    const downloadDir = double['download-directory'] || single['d'] || path.join(process.cwd(), 'downloads');

    if (typeof filename !== 'string') {
        console.error(`Invalid filename: ${filename}`);
        process.exit(1);
    }
    if (typeof downloadDir !== 'string') {
        console.error(`Invalid download directory: ${downloadDir}`);
        process.exit(1);
    }

    const downloadPath = path.join(downloadDir, filename);

    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }

    console.log(`Downloading ${url} to ${downloadPath}`);

    const file = fs.createWriteStream(downloadPath);

    const request = https.get(url, response => {
        if (response.statusCode === 302) {
            console.log(`Redirecting to ${response.headers.location}`);
            request.abort();
            https.get(response.headers.location, response => {
                handleRes(response, filename, file);
            }).on('error', error => {
                console.error(error);
                process.exit(1);
            }).on('end', () => {
                console.log(`Downloaded ${filename}`);
                process.exit(0);
            });
        } else {
            handleRes(response, filename, file);
        }
    });

    file.on('finish', () => {
        file.close();
        console.log(`\nDownloaded ${filename} to ${downloadDir}`);
    });

    request.on('error', error => {
        console.error(error);
        process.exit(1);
    });
} else if (action === 'install') {
    const file = double['file'] || single['f'];
    const build =
        double['insiders'] || single['i']
            ? 'insiders' :
            double['stable'] || single['s']
                ? 'stable' :
                double['build'] || single['b'] || 'stable';
    const dir = double['install-directory'] || single['d'] || (process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA, 'Programs', `Microsoft VS Code${build === 'insiders' ? ' Insiders' : ''}`)
        : process.platform === 'darwin'
            ? path.join(process.env.HOME, 'Applications', `Visual Studio Code${build === 'insiders' ? ' - Insiders' : ''}`)
            : `/usr/share/code${build === 'insiders' ? '-insiders' : ''}`);

    if (typeof file !== 'string') {
        console.error(`Invalid file: ${file}`);
        process.exit(1);
    }

    if (typeof build !== 'string') {
        console.error(`Invalid build: ${build}`);
        process.exit(1);
    }

    if (typeof dir !== 'string') {
        console.error(`Invalid install directory: ${dir}`);
        process.exit(1);
    }

    if (!file) {
        console.error('Missing file');
        process.exit(1);
    }

    if (!fs.existsSync(file)) {
        console.error(`File ${file} does not exist`);
        process.exit(1);
    }

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    if (process.platform === 'linux') {
        try {
            fs.accessSync(dir, fs.constants.W_OK);
        } catch (error) {
            console.error(`Directory ${dir} is not writable, please run as root (sudo)`);
            process.exit(1);
        }

        console.log(`Installing ${file} to ${dir}`);

        tar.x({
            file: file,
            cwd: dir,
            strip: 1
        }).then(() => {
            console.log(`Installed ${file} to ${dir}`);
            process.exit(0);
        });
    } else {
        console.log(`Installing ${file} to ${dir}`);

        const zip = new AdmZip(file);
        zip.extractAllTo(dir, true);

        console.log(`Installed ${file} to ${dir}`);
        process.exit(0);
    }
} else if (action === 'link') {
    const build = double['build'] || single['b'] || 'stable';

    if (typeof build !== 'string') {
        console.error(`Invalid build: ${build}`);
        process.exit(1);
    }

    const dir = double['install-directory'] || single['d'] || (process.platform === 'linux'
        ? `/usr/share/code${build === 'insiders' ? '-insiders' : ''}` :
        process.platform === 'win32'
            ? path.join(process.env.LOCALAPPDATA, 'Programs', `Microsoft VS Code${build === 'insiders' ? ' Insiders' : ''}`)
            : path.join(process.env.HOME, 'Applications', `Visual Studio Code${build === 'insiders' ? ' - Insiders' : ''}`));

    if (typeof dir !== 'string') {
        console.error(`Invalid install directory: ${dir}`);
        process.exit(1);
    }

    const bindir = path.join(dir, 'bin');

    if (!fs.existsSync(bindir)) {
        console.error(`Directory ${bindir} does not exist`);
        process.exit(1);
    }

    const symlinkdir = double['symlink-directory']
        ? double['symlink-directory'] :
        single['s']
            ? single['s'] :
            (path.join(process.platform === 'linux' ? '/usr/bin' : process.env.HOME, 'bin'));

    if (typeof symlinkdir !== 'string') {
        console.error(`Invalid symlink directory: ${symlinkdir}`);
        process.exit(1);
    }

    if (!fs.existsSync(symlinkdir)) {
        console.error(`Directory ${symlinkdir} does not exist`);
        process.exit(1);
    }

    console.log(`Linking ${bindir} to ${symlinkdir}`);

    if (process.platform === 'win32') {
        console.log('Link not needed on Windows');
        process.exit(0);
    }

    try {
        fs.accessSync(bindir, fs.constants.W_OK);
    } catch (error) {
        console.error(`Directory ${bindir} is not writable, please run as root (sudo)`);
        process.exit(1);
    }

    if (!fs.readdirSync(bindir).includes(`code${build === 'insiders' ? '-insiders' : ''}`)) {
        console.error(`File code${build === 'insiders' ? '-insiders' : ''} does not exist`);
        process.exit(1);
    }

    fs.symlinkSync(path.join(bindir, `code${build === 'insiders' ? '-insiders' : ''}`), path.join(symlinkdir, `code${build === 'insiders' ? '-insiders' : ''}`), 'file');
}