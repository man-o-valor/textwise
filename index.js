console.log("📦 Unboxing packages...");
const fs = require("fs");
const path = require("path");
const inquirerModule = require("inquirer");
const Sharp = require("sharp");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const opentype = require("opentype.js");

const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;

function hexToRgb(hex) {
	// Take a guess as to what this one does
	hex = hex.replace(/^#/, "");
	if (hex.length === 3)
		hex = hex
			.split("")
			.map((c) => c + c)
			.join("");
	const hexint = parseInt(hex, 16);
	return { r: (hexint >> 16) & 255, g: (hexint >> 8) & 255, b: hexint & 255 };
}

function distSq(r1, g1, b1, r2, g2, b2) {
	// Calculate color distance in rgb using the 3-dimensional Pythagorean Theorem
	const dr = r1 - r2,
		dg = g1 - g2,
		db = b1 - b2;
	return dr * dr + dg * dg + db * db;
}

async function loadImage(filePath) {
	const img = Sharp(filePath);
	const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}

async function saveImage(outBuffer, width, height, outPath) {
	await Sharp(outBuffer, { raw: { width, height, channels: 4 } })
		.png()
		.toFile(outPath);
	return;
}

async function loadBitmapGlyphs(selectedFontName, solidBackground = false) {
	// Loads glyphs from bitmap spritesheets
	if (!selectedFontName) return null;

	const info = fontInfoArray.find((f) => f.font_name === selectedFontName);
	if (!info) {
		console.error(`🤔 Tried to find font ${selectedFontName} in font-info.json`);
		return null;
	}

	const font_name = info.font_name;
	const glyphWidth = info.glyph_width;
	const glyphHeight = info.glyph_height;
	if (!font_name || !glyphWidth || !glyphHeight) {
		console.error("🤔 Failed to parse font metadata from font-info.json");
		return null;
	}

	const fontPath = path.join(fontsDir, `font-${font_name}.png`);
	if (!fs.existsSync(fontPath)) {
		console.error(`🤔 Could not find the file "font-${font_name}.png" in the fonts folder`);
		return null;
	}

	const fontImage = Sharp(fontPath);
	const fontMeta = await fontImage.metadata();
	const fontColumns = Math.floor(fontMeta.width / glyphWidth);
	const fontRows = Math.floor(fontMeta.height / glyphHeight);
	if (fontColumns <= 0 || fontRows <= 0) {
		console.error(`🚫 Glyph size ${glyphWidth}x${glyphHeight} is larger than font image ${fontMeta.width}x${fontMeta.height}`);
		return null;
	}
	const glyphDictionary = [];

	// Add glyphs to dictionary
	for (let ry = 0; ry < fontRows; ry++) {
		for (let rx = 0; rx < fontColumns; rx++) {
			const left = rx * glyphWidth;
			const top = ry * glyphHeight;
			const { data } = await fontImage
				.clone()
				.extract({ left, top, width: glyphWidth, height: glyphHeight })
				.ensureAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true });

			let covered = 0;
			for (let i = 0; i < data.length; i += 4) {
				const a = data[i + 3];
				const r = data[i],
					g = data[i + 1],
					b = data[i + 2];
				if (a > 127 && (r < 128 || g < 128 || b < 128)) covered++;
			}
			const total = data.length / 4;
			let glyphCoverage = covered / total;

			if (!solidBackground && glyphCoverage > 0.5) {
				// If the glyph covers more than half of its bounding box, store its inverse UNLESS the user chose a solid background
				// This helps choose glyphs later by ensuring that chosen glyph background colors are always the majority of the pixel
				let newCovered = 0;
				for (let i = 0; i < data.length; i += 4) {
					const currentAlpha = data[i + 3];
					data[i + 3] = currentAlpha > 127 ? 0 : 255;

					if (data[i + 3] > 127) {
						newCovered++;
					}
				}
				glyphCoverage = newCovered / total;
			}

			glyphDictionary.push({ data: Buffer.from(data), width: glyphWidth, height: glyphHeight, coverage: glyphCoverage });
		}
	}

	glyphDictionary.sort((a, b) => a.coverage - b.coverage);

	if (solidBackground && glyphDictionary.length > 0) {
		for (let i = 0; i < glyphDictionary.length; i++) {
			glyphDictionary[i].coverage = i / (glyphDictionary.length - 1 || 1);
		}
	}

	return glyphDictionary;
}

async function loadVectorGlyphs(ttfFileName, glyphWidth, latinOnly = true, solidBackground = false) {
	// Loads glyphs from, you guessed it, TTF files
	ttfFileName = ttfFileName + ".ttf";
	const ttfPath = path.join(fontsDir, ttfFileName);
	const fontName = ttfFileName.replace(/\.ttf$/i, "");

	GlobalFonts.registerFromPath(ttfPath, fontName);

	let chars = [];

	if (latinOnly) {
		// If the user enabled the use of only latin characters, only store ones from 32-126
		for (let charCode = 32; charCode <= 126; charCode++) {
			chars.push(String.fromCharCode(charCode));
		}
	} else {
		const fontBuffer = fs.readFileSync(ttfPath);
		const font = opentype.parse(fontBuffer);
		const charsSet = new Set();

		for (let i = 0; i < font.glyphs.length; i++) {
			const glyph = font.glyphs.get(i);
			if (glyph.unicodes && glyph.unicodes.length > 0) {
				for (const code of glyph.unicodes) {
					charsSet.add(String.fromCodePoint(code));
				}
			}
		}

		chars = Array.from(charsSet);
		if (chars.length === 0) {
			throw new Error("No characters found in font file!");
		}
	}

	// Create a virtual 100x100 canvas to render and snapshot glyphs on so we can do pixel calculations later
	const tempCanvas = createCanvas(100, 100);
	const tempCtx = tempCanvas.getContext("2d");
	tempCtx.font = `100px "${fontName}"`;
	const metrics = tempCtx.measureText("M");
	const ratio = metrics.width > 0 ? metrics.width / 100 : 0.5;

	const glyphHeight = Math.max(1, Math.round(glyphWidth / ratio));

	const canvas = createCanvas(glyphWidth, glyphHeight);
	const ctx = canvas.getContext("2d");
	const glyphDictionary = [];

	// Add glyphs to dictionary
	for (const char of chars) {
		ctx.clearRect(0, 0, glyphWidth, glyphHeight);
		ctx.fillStyle = "black";
		ctx.font = `${glyphHeight}px "${fontName}"`;
		ctx.textBaseline = "middle";
		ctx.textAlign = "center";
		ctx.fillText(char, glyphWidth / 2, glyphHeight / 2);

		const imageData = ctx.getImageData(0, 0, glyphWidth, glyphHeight);
		const data = imageData.data;

		let covered = 0;
		for (let i = 0; i < data.length; i += 4) {
			covered += data[i + 3] / 255;
		}
		const total = data.length / 4;
		let glyphCoverage = covered / total;

		if (!solidBackground && glyphCoverage > 0.5) {
			// If the glyph covers more than half of its bounding box, store its inverse UNLESS the user chose a solid background
			// This helps choose glyphs later by ensuring that chosen glyph background colors are always the majority of the pixel
			let newCovered = 0;
			for (let i = 0; i < data.length; i += 4) {
				data[i + 3] = 255 - data[i + 3];
				newCovered += data[i + 3] / 255;
			}
			glyphCoverage = newCovered / total;
		}

		glyphDictionary.push({ data: Buffer.from(data), width: glyphWidth, height: glyphHeight, coverage: glyphCoverage, char: char });
	}

	glyphDictionary.sort((a, b) => a.coverage - b.coverage);

	if (solidBackground && glyphDictionary.length > 0) {
		for (let i = 0; i < glyphDictionary.length; i++) {
			glyphDictionary[i].coverage = i / (glyphDictionary.length - 1 || 1);
		}
	}

	return glyphDictionary;
}

function generateGradient(width, height, pointsCount, colorsArray) {
	// Generates a procedural gradient based on number of points and available colors
	const buf = Buffer.alloc(width * height * 4);

	// Use grayscale colors if none provided
	const useColors = Array.isArray(colorsArray) && colorsArray.length > 0;
	const levels = [];
	if (!useColors) {
		if (pointsCount <= 1) {
			levels.push(128);
		} else {
			for (let i = 0; i < pointsCount; i++) {
				levels.push(Math.round(i * (255 / (pointsCount - 1))));
			}
		}
	}

	// Use rejection sampling to place gradient points far away from each other
	const points = [];
	if (pointsCount <= 1) {
		const x = Math.random() * (width - 1);
		const y = Math.random() * (height - 1);
		if (useColors) {
			const col = colorsArray[0 % colorsArray.length];
			points.push({ x, y, r: col.r, g: col.g, b: col.b });
		} else {
			const lvl = levels[0 % levels.length];
			points.push({ x, y, r: lvl, g: lvl, b: lvl });
		}
	} else {
		const base = Math.min(width, height);
		const minDist = Math.max(1, base / (Math.sqrt(pointsCount) * 1.5));
		const minDist2 = minDist * minDist;
		const maxAttemptsPerPoint = 1000;

		for (let i = 0; i < pointsCount; i++) {
			let placed = false;
			for (let attempt = 0; attempt < maxAttemptsPerPoint; attempt++) {
				const x = Math.random() * (width - 1);
				const y = Math.random() * (height - 1);
				let ok = true;
				for (const p of points) {
					const dx = x - p.x;
					const dy = y - p.y;
					if (dx * dx + dy * dy < minDist2) {
						ok = false;
						break;
					}
				}
				if (ok) {
					if (useColors) {
						const col = colorsArray[i % colorsArray.length];
						points.push({ x, y, r: col.r, g: col.g, b: col.b });
					} else {
						const lvl = levels[i % levels.length];
						points.push({ x, y, r: lvl, g: lvl, b: lvl });
					}
					placed = true;
					break;
				}
			}
			// Fallback case, if placing a point isnt possible then don't worry about rejection sampling
			if (!placed) {
				const x = Math.random() * (width - 1);
				const y = Math.random() * (height - 1);
				if (useColors) {
					const col = colorsArray[i % colorsArray.length];
					points.push({ x, y, r: col.r, g: col.g, b: col.b });
				} else {
					const lvl = levels[i % levels.length];
					points.push({ x, y, r: lvl, g: lvl, b: lvl });
				}
			}
		}
	}

	// Use a gaussian sigma function to make gradients appear smoother and less point-based
	const base = Math.min(width, height);
	const sigma = Math.max(1, (base * 0.5) / Math.sqrt(pointsCount));
	const twoSigma2 = 2 * sigma * sigma;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let nr = 0,
				ng = 0,
				nb = 0;
			let den = 0;
			for (const p of points) {
				const dx = x - p.x;
				const dy = y - p.y;
				const d2 = dx * dx + dy * dy;
				const w = Math.exp(-d2 / twoSigma2);
				nr += w * p.r;
				ng += w * p.g;
				nb += w * p.b;
				den += w;
			}
			const r = den === 0 ? 0 : Math.round(nr / den);
			const g = den === 0 ? 0 : Math.round(ng / den);
			const b = den === 0 ? 0 : Math.round(nb / den);
			const off = (y * width + x) * 4;
			buf[off] = r;
			buf[off + 1] = g;
			buf[off + 2] = b;
			buf[off + 3] = 255;
		}
	}

	return { data: buf, width, height };
}

function channelRanges(pixels) {
	// Finds the ranges of each color channel in an array of pixels
	const mins = [255, 255, 255];
	const maxs = [0, 0, 0];
	for (const p of pixels) {
		mins[0] = Math.min(mins[0], p.r);
		mins[1] = Math.min(mins[1], p.g);
		mins[2] = Math.min(mins[2], p.b);
		maxs[0] = Math.max(maxs[0], p.r);
		maxs[1] = Math.max(maxs[1], p.g);
		maxs[2] = Math.max(maxs[2], p.b);
	}
	return {
		mins,
		maxs,
		ranges: [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]],
	};
}

function splitBox(pixels) {
	// Splits a cluster assignment box to add a new color to the palette
	if (pixels.length <= 1) return [pixels, []];
	const { ranges } = channelRanges(pixels);
	let channel = 0;
	if (ranges[1] > ranges[channel]) channel = 1;
	if (ranges[2] > ranges[channel]) channel = 2;
	pixels.sort((a, b) => a[["r", "g", "b"][channel]] - b[["r", "g", "b"][channel]]);
	const mid = Math.floor(pixels.length / 2);
	return [pixels.slice(0, mid), pixels.slice(mid)];
}

function averageColor(pixels) {
	// Finds the average color of an array of pixels
	if (pixels.length === 0) return { r: 0, g: 0, b: 0 };
	let r = 0,
		g = 0,
		b = 0;
	for (const p of pixels) {
		r += p.r;
		g += p.g;
		b += p.b;
	}
	const n = pixels.length;
	return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

async function quantizeImage(imgData, paletteSize, forcedPalette) {
	// Crushes an image down to a set palette, defined by the number of colors to use
	const { data, width, height } = imgData;
	const pixels = [];
	for (let i = 0; i < data.length; i += 4) {
		pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] });
	}

	let boxes = [pixels];
	while (boxes.length < paletteSize) {
		let bestIndex = -1;
		let bestRange = -1;
		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i];
			if (box.length <= 1) continue;
			const { ranges } = channelRanges(box);
			const boxBest = Math.max(...ranges);
			if (boxBest > bestRange) {
				bestRange = boxBest;
				bestIndex = i;
			}
		}
		if (bestIndex === -1) break;
		const boxToSplit = boxes.splice(bestIndex, 1)[0];
		const [a, b] = splitBox(boxToSplit);
		boxes.push(a);
		if (b.length > 0) boxes.push(b);
	}

	const computedPalette = boxes.map(averageColor);

	// If forcedPalette is provided use those colors first before populating with derived colors
	let finalPalette = [];
	if (Array.isArray(forcedPalette) && forcedPalette.length > 0) {
		finalPalette = forcedPalette.map((c) => ({ r: c.r, g: c.g, b: c.b }));
		const remaining = Math.max(0, paletteSize - finalPalette.length);
		for (let i = 0; i < Math.min(remaining, computedPalette.length); i++) {
			finalPalette.push(computedPalette[i]);
		}
		while (finalPalette.length < paletteSize) {
			finalPalette.push(averageColor(pixels));
		}
		finalPalette = finalPalette.slice(0, paletteSize);
	} else {
		finalPalette = computedPalette.slice(0, paletteSize);
	}

	const paletteFreq = new Array(finalPalette.length).fill(0);
	const out = Buffer.from(data);
	for (let i = 0, pi = 0; i < out.length; i += 4, pi++) {
		const pr = data[i],
			pg = data[i + 1],
			pb = data[i + 2];
		let best = 0,
			bestDist = Infinity;
		for (let j = 0; j < finalPalette.length; j++) {
			const c = finalPalette[j];
			const dr = pr - c.r,
				dg = pg - c.g,
				db = pb - c.b;
			const d = dr * dr + dg * dg + db * db;
			if (d < bestDist) {
				bestDist = d;
				best = j;
			}
		}

		paletteFreq[best]++;
		const c = finalPalette[best];
		out[i] = c.r;
		out[i + 1] = c.g;
		out[i + 2] = c.b;
	}

	for (let j = 0; j < finalPalette.length; j++) {
		finalPalette[j].freq = paletteFreq[j] || 0;
	}

	return { outBuffer: out, width, height, palette: finalPalette };
}

async function pixelateBufferResize(buf, width, height, blockW, blockH) {
	// Downsample an image with respect to the modal color, using the blockW and blockH as finished "pixel" dimensions
	const sw = Math.max(1, Math.floor(width / blockW));
	const sh = Math.max(1, Math.floor(height / blockH));
	const small = Buffer.alloc(sw * sh * 4);
	for (let sy = 0; sy < sh; sy++) {
		const y0 = sy * blockH;
		const y1 = Math.min(height, y0 + blockH);
		for (let sx = 0; sx < sw; sx++) {
			const x0 = sx * blockW;
			const x1 = Math.min(width, x0 + blockW);
			let sr = 0,
				sg = 0,
				sb = 0,
				sa = 0,
				count = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const idx = (y * width + x) * 4;
					sr += buf[idx];
					sg += buf[idx + 1];
					sb += buf[idx + 2];
					sa += buf[idx + 3];
					count++;
				}
			}
			const off = (sy * sw + sx) * 4;
			if (count === 0) {
				small[off] = 0;
				small[off + 1] = 0;
				small[off + 2] = 0;
				small[off + 3] = 255;
			} else {
				small[off] = Math.round(sr / count);
				small[off + 1] = Math.round(sg / count);
				small[off + 2] = Math.round(sb / count);
				small[off + 3] = Math.round(sa / count);
			}
		}
	}

	return { data: small, width: sw, height: sh };
}

// Parse font metadata and provided fonts
const fontsDir = path.join(baseDir, "fonts");
const infoPath = path.join(fontsDir, "font-info.json");
let fontInfoArray = [];
let availableFonts = [];
try {
	fontInfoArray = JSON.parse(fs.readFileSync(infoPath, "utf8"));
	availableFonts = fontInfoArray.map((f) => f.font_name);
} catch (e) {
	console.error("🚫 Failed to parse font-info.json: ", e);
}
const fontFiles = fs.readdirSync(fontsDir);
const ttfFiles = fontFiles.filter((f) => f.toLowerCase().endsWith(".ttf"));
availableFonts = availableFonts.concat(ttfFiles.map((str) => str.slice(0, -4)));

const inputDir = path.join(baseDir, "input");
let detectedImages = [];
try {
	const inputFiles = fs.readdirSync(inputDir);
	detectedImages = inputFiles.filter((file) => /\.(png|jpg|jpeg)$/i.test(file));
} catch (e) {
	console.error("🤔 Input folder not detected");
}

const questions = [
	// Question time
	{
		type: "list",
		name: "imageSetting",
		message: "🖌️ Choose image type:",
		choices: ["📄 From File", "🌈 Gradient"],
		default: "📄 From File",
	},
	{
		type: detectedImages.length > 0 ? "list" : "input",
		name: "imagePath",
		message: detectedImages.length > 0 ? "🖼️ Choose an image from the input folder:" : "🤔 No images found in ./input. Enter local filepath manually:",
		choices: detectedImages.length > 0 ? detectedImages : undefined,
		when: (answers) => answers.imageSetting !== "🌈 Gradient",
		validate: (input) => {
			if (detectedImages.length > 0) return true;
			return fs.existsSync(input) ? true : "🤔 File path does not exist";
		},
	},
	{
		type: "input",
		name: "paletteSize",
		message: "🎨 Enter palette size:",
		default: "16",
		validate: (input) => {
			const val = parseInt(input);
			return val > 1 ? true : "🤔 Palette size must be a positive number greater than 1";
		},
	},
	{
		type: "input",
		name: "pixelSize",
		message: "🔠 Enter font size:",
		default: "8",
		when: (answers) => answers.imageSetting !== "🌈 Gradient",
		validate: (input) => {
			const val = parseInt(input);
			return val > 0 ? true : "🤔 Pixel size must be a positive integer";
		},
	},
	{
		type: "input",
		name: "gradientColorsInput",
		message: "🎛️ Enter hex colors of the gradient, separated by spaces:",
		when: (answers) => answers.imageSetting === "🌈 Gradient",
		validate: (input) => {
			if (!input || input.trim().length === 0) return true;
			const parts = input.trim().split(/\s+/);
			for (const p of parts) {
				if (!/^#?[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(p)) return "🤔 One or more of the given colors isn't a valid hex code";
			}
			return true;
		},
	},
	{
		type: "input",
		name: "gradientPointsNumber",
		message: "🔅 Enter the number of gradient points:",
		when: (answers) => answers.imageSetting === "🌈 Gradient",
		default: (answers) => answers.gradientColorsInput?.trim()?.match(/\s+/g)?.length + 1 || "8",
		validate: (input) => {
			const val = parseInt(input);
			return !isNaN(val) && val > 0 ? true : "🤔 Gradient point count must be a positive integer";
		},
	},
	{
		type: "input",
		name: "resolutionWidth",
		message: "📐 Enter the width of the gradient image in glyphs",
		when: (answers) => answers.imageSetting === "🌈 Gradient",
		default: "128",
		validate: (input) => {
			const val = parseInt(input);
			return !isNaN(val) && val > 0 ? true : "🤔 Gradient width count must be a positive integer";
		},
	},
	{
		type: "input",
		name: "resolutionHeight",
		message: "📐 Enter the height of the gradient image in glyphs",
		when: (answers) => answers.imageSetting === "🌈 Gradient",
		default: "128",
		validate: (input) => {
			const val = parseInt(input);
			return !isNaN(val) && val > 0 ? true : "🤔 Gradient height count must be a positive integer";
		},
	},
	{
		type: availableFonts.length > 0 ? "list" : "input",
		name: "fontChoice",
		message: "🔤 Choose a font for the mosaic:",
		choices: availableFonts,
	},
	{
		type: "input",
		name: "ttfWidth",
		message: "🔎 Enter the resolution width glyphs are rendered at:",
		default: "8",
		when: (answers) => answers.fontChoice && availableFonts.indexOf(answers.fontChoice) >= availableFonts.length - ttfFiles.length,
		validate: (input) => {
			const val = parseInt(input);
			return !isNaN(val) && val > 0 ? true : "🤔 Gradient height count must be a positive integer";
		},
	},
	{
		type: "confirm",
		name: "ttfLatinOnly",
		message: "📜 Use latin characters only?", // Should be used for fonts with unwanted exotic glyphs
		default: false,
		when: (answers) => answers.fontChoice && availableFonts.indexOf(answers.fontChoice) >= availableFonts.length - ttfFiles.length,
	},
	{
		type: "confirm",
		name: "solidBackground",
		message: "📃 Use a solid background color?",
		default: false,
	},
	{
		type: "input",
		name: "bgColorPreference",
		message: "💧 Enter background color in hex, or leave empty for auto:",
		when: (answers) => answers.solidBackground,
		validate: (input) => {
			if (!input) return true;
			return /^#?([0-9A-F]{3}){1,2}$/i.test(input) ? true : "🤔 Background color must be empty or a valid hex code, such as #123ABC";
		},
	},
	{
		type: "confirm",
		name: "messy",
		message: "🥴 Use messy glyphs?", // When Y, glyphs with identical coverage will be randomized to make flat areas more varied
		default: true,
	},
];

async function run() {
	// Ask prompts
	const answers = await inquirerModule.prompt(questions);

	// Load glyphs
	let glyphs;
	if (answers.fontChoice) {
		try {
			if (availableFonts.indexOf(answers.fontChoice) >= availableFonts.length - ttfFiles.length) {
				const w = parseInt(answers.ttfWidth);
				glyphs = await loadVectorGlyphs(answers.fontChoice, w, answers.ttfLatinOnly, answers.solidBackground);
			} else {
				glyphs = await loadBitmapGlyphs(answers.fontChoice, answers.solidBackground);
			}
		} catch (e) {
			console.error("🚫 Error loading glyphs:", e);
			glyphs = null;
		}
	}
	if (!(glyphs && Array.isArray(glyphs) && glyphs.length > 0)) {
		console.error("🚨 Aborting: Glyphs failed to load or are malformed");
		return;
	}

	// Get image path of selected input image (as long as the user didn't select Gradient)
	let finalImagePath = null;
	if (answers.imageSetting !== "🌈 Gradient") {
		finalImagePath = detectedImages.includes(answers.imagePath) ? path.join(inputDir, answers.imagePath) : answers.imagePath;
	}

	try {
		// Generate gradient or load input image
		const paletteSize = Math.max(2, parseInt(answers.paletteSize) || 8);
		let imgData;
		let colorsArray = null;
		if (answers.imageSetting === "🌈 Gradient") {
			const gw = Math.max(1, parseInt(answers.resolutionWidth || 128));
			const gh = Math.max(1, parseInt(answers.resolutionHeight || 128));
			let points = Math.max(1, parseInt(answers.gradientPointsNumber || 4));
			if (answers.gradientColorsInput && answers.gradientColorsInput.trim().length > 0) {
				const parts = answers.gradientColorsInput.trim().split(/\s+/);
				colorsArray = parts.map((p) => hexToRgb(p));
				points = Math.max(1, colorsArray.length);
			}
			imgData = generateGradient(gw, gh, points, colorsArray);
		} else {
			imgData = await loadImage(finalImagePath);
		}

		// Quantize to limited palette
		const { outBuffer: quantizedBuffer, width, height, palette } = await quantizeImage(imgData, paletteSize, colorsArray);

		// Downsample the image according to font size, with respect to the modal color in each glyph's bounding box
		const pixelSize = answers.imageSetting === "🌈 Gradient" ? 1 : Math.max(1, parseInt(answers.pixelSize) || 1);
		let finalBuffer = quantizedBuffer;
		let originalBuffer = imgData.data;
		let [finalWidth, finalHeight] = [width, height];
		let [glyphWidth, glyphHeight] = [1, 1];
		if (glyphs && Array.isArray(glyphs) && glyphs.length > 0) {
			glyphWidth = glyphs[0].width;
			glyphHeight = glyphs[0].height;
		}
		const minDim = Math.min(glyphWidth, glyphHeight);
		const blockW = Math.max(1, Math.round(pixelSize * (glyphWidth / minDim)));
		const blockH = Math.max(1, Math.round(pixelSize * (glyphHeight / minDim)));
		if (blockW > 1 || blockH > 1) {
			const small = await pixelateBufferResize(quantizedBuffer, width, height, blockW, blockH);
			finalBuffer = small.data;
			const smallOrig = await pixelateBufferResize(imgData.data, width, height, blockW, blockH);
			originalBuffer = smallOrig.data;
			finalWidth = small.width;
			finalHeight = small.height;
		}

		if (!(Array.isArray(palette) && palette.length >= 2)) {
			console.error("🚨 Aborting: Palette is malformed or too short");
			return;
		}

		const bigW = finalWidth * glyphWidth;
		const bigH = finalHeight * glyphHeight;
		const big = Buffer.alloc(bigW * bigH * 4);

		const paletteColors = palette.map((c) => ({ r: c.r, g: c.g, b: c.b }));

		// If the user selected a solid background color, apply it
		let globalBgColor = null;
		if (answers.solidBackground) {
			if (answers.bgColorPreference) {
				globalBgColor = hexToRgb(answers.bgColorPreference);
			} else {
				let maxFreq = -1;
				for (const c of palette) {
					if (c.freq > maxFreq) {
						maxFreq = c.freq;
						globalBgColor = { r: c.r, g: c.g, b: c.b };
					}
				}
			}
		}

		// Choose and render glyphs
		for (let sy = 0; sy < finalHeight; sy++) {
			for (let sx = 0; sx < finalWidth; sx++) {
				const sIdx = (sy * finalWidth + sx) * 4;

				const pr = originalBuffer[sIdx],
					pg = originalBuffer[sIdx + 1],
					pb = originalBuffer[sIdx + 2];

				let primary, secondary, secWeight;

				if (answers.solidBackground) {
					// If the user chose a solid background, use the best color for glyphs
					primary = globalBgColor;
					let bestSecondary = -1;
					let minSecondaryDist = Infinity;

					for (let i = 0; i < paletteColors.length; i++) {
						const c = paletteColors[i];
						if (c.r === globalBgColor.r && c.g === globalBgColor.g && c.b === globalBgColor.b) continue;
						const d = distSq(pr, pg, pb, c.r, c.g, c.b);
						if (d < minSecondaryDist) {
							minSecondaryDist = d;
							bestSecondary = i;
						}
					}

					secondary = bestSecondary === -1 ? primary : paletteColors[bestSecondary];

					const dp = distSq(pr, pg, pb, primary.r, primary.g, primary.b);
					const ds = distSq(pr, pg, pb, secondary.r, secondary.g, secondary.b);

					secWeight = dp + ds === 0 ? 0 : 1 - ds / (dp + ds);
				} else {
					// If the user did not choose a solid background, use the second best color for glyphs
					// Since glyphs were normalized earlier to all have <50% coverage glyphs are guaranteed to represent less color than their backgrounds
					let best = -1,
						second = -1,
						bd = Infinity,
						sd = Infinity;
					for (let i = 0; i < paletteColors.length; i++) {
						const c = paletteColors[i];
						const d = distSq(pr, pg, pb, c.r, c.g, c.b);
						if (d < bd) {
							sd = bd;
							second = best;
							bd = d;
							best = i;
						} else if (d < sd) {
							sd = d;
							second = i;
						}
					}

					if (best === -1) continue;
					primary = paletteColors[best];
					secondary = second === -1 ? primary : paletteColors[second];

					const dp = bd,
						ds = sd;
					secWeight = dp + ds === 0 ? 0 : (1 - ds / (dp + ds)) * 2;
				}

				let bestCovDiff = Infinity;
				let targetCoverage = -1;

				for (let gi = 0; gi < glyphs.length; gi++) {
					const diff = Math.abs(glyphs[gi].coverage - secWeight);
					if (diff < bestCovDiff) {
						bestCovDiff = diff;
						targetCoverage = glyphs[gi].coverage;
					}
				}

				const candidateIndices = [];
				for (let gi = 0; gi < glyphs.length; gi++) {
					if (Math.abs(glyphs[gi].coverage - targetCoverage) < 0.000001) {
						candidateIndices.push(gi);
					}
				}

				const chosenIndex = answers.messy ? candidateIndices[Math.floor(Math.random() * candidateIndices.length)] : candidateIndices[0];
				const glyph = glyphs[chosenIndex];

				const gbuf = glyph.data;
				for (let gy = 0; gy < glyphHeight; gy++) {
					for (let gx = 0; gx < glyphWidth; gx++) {
						const gi = (gy * glyphWidth + gx) * 4;
						const alpha = gbuf[gi + 3];

						const bx = sx * glyphWidth + gx;
						const by = sy * glyphHeight + gy;
						const di = (by * bigW + bx) * 4;

						const aWeight = alpha / 255;
						const invAWeight = 1 - aWeight;

						big[di] = Math.round(secondary.r * aWeight + primary.r * invAWeight);
						big[di + 1] = Math.round(secondary.g * aWeight + primary.g * invAWeight);
						big[di + 2] = Math.round(secondary.b * aWeight + primary.b * invAWeight);
						big[di + 3] = 255;
					}
				}
			}
		}

		finalBuffer = big;
		finalWidth = bigW;
		finalHeight = bigH;

		// Generate filename
		const outDir = path.join(baseDir, "output");
		if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
		const base =
			answers.imageSetting === "🌈 Gradient"
				? `gradient-${Math.max(1, parseInt(answers.resolutionWidth || 512))}x${Math.max(1, parseInt(answers.resolutionHeight || 512))}`
				: path.basename(finalImagePath, path.extname(finalImagePath));
		const outPath = path.join(
			outDir,
			`${base}-${paletteSize}col-${answers.fontChoice}${pixelSize ? "-" + pixelSize : ""}px${answers.messy ? "-m" : ""}${answers.solidBackground ? "-solid" : ""}.png`,
		);

		// Save image
		await saveImage(finalBuffer, finalWidth, finalHeight, outPath);
		console.log("✅ Saved output image image to:", outPath);
	} catch (err) {
		console.error("🚫 Error processing image:", err);
	}
}

async function loop() {
	while (true) {
		await run();

		const againQuestion = {
			type: "confirm",
			name: "doAgain",
			message: "🔄️ Generate another image?",
			default: true,
		};

		let goAgain = await inquirerModule.prompt(againQuestion);

		if (!goAgain.doAgain) {
			break;
		}
	}
}

loop()
