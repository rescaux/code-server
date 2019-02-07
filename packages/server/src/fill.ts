import * as fs from "fs";
import * as util from "util";
import { isCli } from "./constants";

const oldAccess = fs.access;
const existsWithinBinary = (path: fs.PathLike): Promise<boolean> => {
	return new Promise<boolean>((resolve): void => {
		if (typeof path === "number") {
			if (path < 0) {
				return resolve(true);
			}
		}
		oldAccess(path, fs.constants.F_OK, (err) => {
			const exists = !err;
			const es = fs.existsSync(path);
			const res = !exists && es;
			resolve(res);
		});
	});
};

export const fillFs = (): void => {
	/**
	 * Refer to https://github.com/nexe/nexe/blob/master/src/fs/patch.ts
	 * For impls
	 */

	if (!isCli) {
		throw new Error("Should not fill FS when not in CLI");
	}

	interface FD {
		readonly path: string;
		position: number;
	}

	let lastFd = Number.MIN_SAFE_INTEGER;
	const fds = new Map<number, FD>();

	const replaceNative = <T extends keyof typeof fs>(propertyName: T, func: (callOld: () => void, ...args: any[]) => any, customPromisify?: (...args: any[]) => Promise<any>): void => {
		const oldFunc = (<any>fs)[propertyName];
		fs[propertyName] = (...args: any[]) => {
			try {
				return func(() => {
					return oldFunc(...args);
				}, ...args);
			} catch (ex) {
				return oldFunc(...args);
			}
		};
		if (customPromisify) {
			(<any>fs[propertyName])[util.promisify.custom] = customPromisify;
		}
	};

	replaceNative("access", (callNative, path, mode, callback) => {
		existsWithinBinary(path).then((exists) => {
			if (!exists) {
				return callNative();
			}

			return callback();
		});
	});

	replaceNative("exists", (callOld, path, callback) => {
		existsWithinBinary(path).then((exists) => {
			if (exists) {
				return callback(true);
			}

			return callOld();
		});
	}, (path) => new Promise((res) => fs.exists(path, res)));

	replaceNative("open", (callOld, path: fs.PathLike, flags: string | Number, mode: any, callback: any) => {
		existsWithinBinary(path).then((exists) => {
			if (!exists) {
				return callOld();
			}

			if (typeof mode === "function") {
				callback = mode;
				mode = undefined;
			}

			if (path === process.execPath) {
				return callOld();
			}

			const fd = lastFd++;
			fds.set(fd, {
				path: path.toString(),
				position: 0,
			});
			callback(undefined, fd);
		});
	});

	replaceNative("close", (callOld, fd: number, callback) => {
		if (!fds.has(fd)) {
			return callOld();
		}

		fds.delete(fd);
		callback();
	});

	replaceNative("read", (callOld, fd: number, buffer: Buffer, offset: number, length: number, position: number | null, callback?: (err: NodeJS.ErrnoException, bytesRead: number, buffer: Buffer) => void, ) => {
		if (!fds.has(fd)) {
			return callOld();
		}

		const fileDesc = fds.get(fd)!;

		/**
		 * `readFile` is filled within nexe, but `read` is not
		 * https://github.com/nexe/nexe/blob/master/src/fs/patch.ts#L199
		 * We can simulate a real _read_ by reading the entire file.
		 * Efficiency can be improved here by storing the entire file in memory
		 * until it has been closed.
		 */
		return fs.readFile(fileDesc.path, (err, rb) => {
			if (err) {
				return callOld();
			}

			rb = rb.slice(position || fileDesc.position);
			const sliced = rb.slice(0, length);
			if (position === null) {
				fileDesc.position += sliced.byteLength;
			}
			buffer.set(sliced, offset);
			if (callback) {
				callback(undefined!, sliced.byteLength, buffer);
			}
		});
	}, (fd: number, buffer: Buffer, offset: number, length: number, position: number | null): Promise<{
		bytesRead: number;
		buffer: Buffer;
	}> => {
		return new Promise((res, rej) => {
			fs.read(fd, buffer, offset, length, position, (err, bytesRead, buffer) => {
				if (err) {
					return rej(err);
				}

				res({
					bytesRead,
					buffer,
				});
			});
		});
	});
};
