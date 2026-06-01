import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { PrefsFields } from './constants.js';

export class Registry {
    constructor ({ settings, uuid }) {
        this.settings = settings;

        this.REGISTRY_DIRPATH = GLib.get_user_cache_dir() + '/' + uuid;
        this.REGISTRY_FILEPATH = this.REGISTRY_DIRPATH + '/' + 'registry.txt';
        this.REGISTRY_FILEPATH_BACKUP = this.REGISTRY_FILEPATH + '~';
    }

    /**
     * Read clipboard entries from the registry
     *
     * @returns {Promise<Array<ClipboardEntry>>}
     */
    async read () {
        if (!GLib.file_test(this.REGISTRY_FILEPATH, GLib.FileTest.EXISTS)) {
            return [];
        }

        // Check if file size is larger than CACHE_FILE_SIZE
        // If so, make a backup of file, and resolve with empty array
        const CACHE_FILE_SIZE = this.settings.get_int(PrefsFields.CACHE_FILE_SIZE);
        const file = Gio.File.new_for_path(this.REGISTRY_FILEPATH);
        const fileInfo = await file.query_info_async(
            '*',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (obj, res) => obj.query_info_finish(res),
        );
        if (fileInfo.get_size() >= CACHE_FILE_SIZE * 1024 * 1024) {
            const dist = Gio.File.new_for_path(this.REGISTRY_FILEPATH_BACKUP);
            file.move(dist, Gio.FileCopyFlags.OVERWRITE, null, null);
            return [];
        }

        // Read and parse registry entries
        const contents = await readContentsFromFile(this.REGISTRY_FILEPATH);
        const text = new TextDecoder().decode(contents || undefined).trim();
        const registry = text.length
            ? JSON.parse(text)
            : [];
        const entries = await Promise.all(registry.map(item => ClipboardEntry.fromRegistryItem(item)));
        const result = entries.filter(Boolean);

        // Limit to HISTORY_SIZE
        const HISTORY_SIZE = this.settings.get_int(PrefsFields.HISTORY_SIZE);
        let registryNoFavorite = result.filter(entry => !entry.isFavorite());
        while (registryNoFavorite.length > HISTORY_SIZE) {
            const idx = result.indexOf(registryNoFavorite.shift());
            result.splice(idx, 1);
            registryNoFavorite = result.filter(entry => !entry.isFavorite());
        }

        return result;
    }

    /**
     * Write clipboard entries to the registry
     *
     * @param {Array<ClipboardEntry>} entries
     * @returns {Promise<void>}
     */
    async write (entries) {
        // Make sure dir exists
        const mode = parseInt('0775', 8);
        GLib.mkdir_with_parents(this.REGISTRY_DIRPATH, mode);

        // Write images to files
        const images = entries.filter(entry => entry.isImage());
        await Promise.all(images.map(entry => this.writeImageToFile(entry)));

        // Write contents to registry file
        const registry = entries.map(entry => entry.toRegistryItem(this.REGISTRY_DIRPATH));
        const json = JSON.stringify(registry);
        const contents = new GLib.Bytes(json);
        const result = writeContentsToFile(this.REGISTRY_FILEPATH, contents);

        return result;
    }

    /**
     * Load image as St.Icon
     *
     * @param {ClipboardEntry} entry
     * @returns {Promise<St.Icon>}
     */
    async getEntryAsImage (entry) {
        if (!entry.isImage()) {
            return Promise.reject('Entry is not an image');
        }

        const path = entry.getFilepath(this.REGISTRY_DIRPATH);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            await this.writeImageToFile(entry);
        }

        const gicon = Gio.icon_new_for_string(path);
        const result = new St.Icon({ gicon });

        return result;
    }

    /**
     * Load image as Clutter.Actor
     *
     * @param {ClipboardEntry} entry
     * @returns {Promise<Clutter.Actor>}
     */
    async getEntryAsTexture (entry) {
        if (!entry.isImage()) {
            return Promise.reject('Entry is not an image');
        }

        const path = entry.getFilepath(this.REGISTRY_DIRPATH);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            await this.writeImageToFile(entry);
        }

        const file = Gio.File.new_for_path(path);
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const result = St.TextureCache.get_default().load_file_async(file, -1, -1, scaleFactor, 1.0);

        return result;
    }

    /**
     * Write an image entry to file
     *
     * @param {ClipboardEntry} entry
     * @returns {Promise<void>}
     */
    async writeImageToFile (entry) {
        if (!entry.isImage()) {
            return Promise.reject('Entry is not an image');
        }

        const path = entry.getFilepath(this.REGISTRY_DIRPATH);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            return;
        }

        const contents = entry.asBytes();
        const result = writeContentsToFile(path, contents);

        return result;
    }

    async deleteEntryFile (entry) {
        const path = entry.getFilepath(this.REGISTRY_DIRPATH);
        const file = Gio.File.new_for_path(path);

        try {
            await file.delete_async(GLib.PRIORITY_DEFAULT, null);
        }
        catch (e) {
            console.error(e);
        }
    }

    clearCacheFolder() {
        const CANCELLABLE = null;

        try {
            const folder = Gio.File.new_for_path(this.REGISTRY_DIRPATH);
            const enumerator = folder.enumerate_children("", 1, CANCELLABLE);

            let file;
            while ((file = enumerator.iterate(CANCELLABLE)[2]) != null) {
                file.delete(CANCELLABLE);
            }

        }
        catch (e) {
            console.error(e);
        }
    }
}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    #favorite;

    /**
     * Check if the mimetype is a text entry
     *
     * @param {string} mimetype
     * @returns {boolean}
     */
    static __isText (mimetype) {
        return false
            || mimetype.startsWith('text/')
            || mimetype === 'STRING'
            || mimetype === 'UTF8_STRING';
    }

    /**
     * Load the contents of an entry based on its mimetype
     *
     * @param {string} contents
     * @param {string} mimetype
     * @returns {Promise<Uint8Array<ArrayBuffer> | null>}
     */
    static async __loadContents (contents, mimetype) {
        if (ClipboardEntry.__isText(mimetype)) {
            return new TextEncoder().encode(contents);
        }

        const path = contents;
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            return null;
        }

        const result = readContentsFromFile(path);

        return result;
    }

    /**
     * Create an instance from a registry item
     *
     * @param {Record<string, any>} item
     * @returns {Promise<ClipboardEntry | null>}
     */
    static async fromRegistryItem (item) {
        const contents = item.contents;
        const favorite = item.favorite;
        const mimetype = item.mimetype || 'text/plain;charset=utf-8';
        const tag = item.tag;

        const bytes = await ClipboardEntry.__loadContents(contents, mimetype);
        if (!bytes) {
            return null;
        }

        const result = new ClipboardEntry(mimetype, bytes, favorite);
        if (tag) {
            result.setTag(tag);
        }

        return result;
    }

    constructor (mimetype, bytes, favorite) {
        this.#mimetype = mimetype;
        this.#bytes = bytes;
        this.#favorite = favorite;
    }

    #encode () {
        if (this.isImage()) {
            return [...this.#bytes]
                .map(x => x.toString(16).padStart(2, '0'))
                .join('');
        }

        return this.getStringValue();
    }

    getStringValue () {
        if (this.isImage()) {
            return `[Image ${this.asBytes().hash()}]`;
        }

        return new TextDecoder().decode(this.#bytes);
    }

    mimetype () {
        return this.#mimetype;
    }

    isFavorite () {
        return this.#favorite;
    }

    set favorite (val) {
        this.#favorite = !!val;
    }

    isText () {
        return ClipboardEntry.__isText(this.#mimetype);
    }

    isImage () {
        return this.#mimetype.startsWith('image/');
    }

    setText (text) {
        if (this.isImage()) {
            return;
        }

        this.#bytes = new TextEncoder().encode(text);
    }

    #tag = null;

    getTag () {
        return this.#tag;
    }

    setTag (tag) {
        this.#tag = tag || null;
    }

    asBytes () {
        return GLib.Bytes.new(this.#bytes);
    }

    equals (otherEntry) {
        return this.getStringValue() === otherEntry.getStringValue();
        // this.asBytes().equal(otherEntry.asBytes());
    }

    /**
     * Get the filepath
     *
     * @param {string} registryDirpath
     * @returns {string}
     */
    getFilepath (registryDirpath) {
        return registryDirpath + '/' + this.asBytes().hash();
    }

    /**
     * Convert entry to registry item
     *
     * @param {string} registryDirpath
     * @returns {Record<string, any>}
     */
    toRegistryItem (registryDirpath) {
        const contents = this.isImage()
            ? this.getFilepath(registryDirpath)
            : this.getStringValue();
        const tag = this.#tag;

        return {
            contents,
            favorite: this.#favorite,
            mimetype: this.#mimetype,
            ...(tag ? { tag } : {}),
        }
    }

    /**
     * Convert to a trimmed variant
     *
     * @returns {ClipboardEntry}
     */
    toTrimmed () {
        const input = this.getStringValue().trim();
        const bytes = new TextEncoder().encode(input);

        return new ClipboardEntry(this.#mimetype, bytes, this.#favorite);
    }
}

/**
 * Read contents from a file
 *
 * @param {string} path
 * @returns {Promise<GLib.Bytes | null>}
 */
async function readContentsFromFile(path) {
    const file = Gio.File.new_for_path(path);
    const result = file.load_contents_async(
        null,
        (obj, res) => {
            const [ok, contents] = obj.load_contents_finish(res);
            if (!ok) {
                console.error(`Clipboard Indicator: failed to read file at ${path}`);
                return null;
            }

            return contents;
        },
    );

    return result;
}

/**
 * Write contents to a file
 *
 * @param {string} path
 * @param {GLib.Bytes} contents
 * @returns {Promise<void>}
 */
async function writeContentsToFile(path, contents) {
    const file = Gio.File.new_for_path(path);
    const stream = await file.replace_async(
        null,
        false,
        Gio.FileCreateFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        null,
        (obj, res) => obj.replace_finish(res),
    );
    const result = stream.write_bytes_async(
        contents,
        GLib.PRIORITY_DEFAULT,
        null,
        (obj, res) => {
            obj.write_bytes_finish(res);
            stream.close(null);
        },
    );

    return result;
}
