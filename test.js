let openCvReady = false;
let imagePreview = null;
let imageLoaded = false;
let processingStatus = null;
let progressFill = null;

function onOpenCvReady() {
    console.log("OpenCV is ready");
    openCvReady = true;
    document.getElementById("opencv-loading").classList.add("hidden");
}

window.onload = function () {
    if (typeof cv !== "undefined") {
        console.log("OpenCV already loaded");
        onOpenCvReady();
    } else {
        console.log("Waiting for OpenCV...");
    }
};

async function recognizeSudokuFromImage() {
    // Validate image is loaded
    if (!imageLoaded || !imagePreview || !imagePreview.complete || !imagePreview.naturalHeight) {
        throw new Error("Image not loaded");
    }

    // Create offscreen canvas and draw image
    const canvas = document.createElement("canvas");
    canvas.width = imagePreview.naturalWidth;
    canvas.height = imagePreview.naturalHeight;
    canvas.getContext("2d").drawImage(imagePreview, 0, 0);

    try {
        // Read and immediately resize image to 450×450 for faster processing
        let src = cv.imread(canvas);
        cv.resize(src, src, new cv.Size(450, 450), 0, 0, cv.INTER_AREA);
        let original = src.clone();

        // Preprocess: convert to grayscale, blur, and adaptive threshold
        cv.cvtColor(src, src, cv.COLOR_RGBA2GRAY, 0);
        cv.GaussianBlur(src, src, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
        cv.adaptiveThreshold(src, src, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 11, 2);

        // Find contours and pick the largest one (assumed to be the grid)
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        cv.findContours(src, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        let maxArea = 0,
        sudokuContour = null;
        for (let i = 0; i < contours.size(); i++) {
        let cnt = contours.get(i);
        let area = cv.contourArea(cnt);
        if (area > maxArea) {
            maxArea = area;
            sudokuContour = cnt;
        }
        }
        if (!sudokuContour) {
        throw new Error("No contour found for the Sudoku grid.");
        }

        // Approximate contour to a 4-point polygon
        let peri = cv.arcLength(sudokuContour, true);
        let approx = new cv.Mat();
        cv.approxPolyDP(sudokuContour, approx, 0.02 * peri, true);
        if (approx.rows !== 4) {
        throw new Error("Could not detect a proper 4-corner Sudoku grid.");
        }

        // Extract corners and sort them
        let corners = [];
        for (let i = 0; i < 4; i++) {
        corners.push({
            x: approx.intPtr(i, 0)[0],
            y: approx.intPtr(i, 0)[1],
        });
        }
        corners = sortCorners(corners);

        // Warp the perspective to a fixed 450×450 image
        const size = 450;
        let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        corners[0].x, corners[0].y,
        corners[1].x, corners[1].y,
        corners[2].x, corners[2].y,
        corners[3].x, corners[3].y,
        ]);
        let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, size, 0, size, size, 0, size]);
        let M = cv.getPerspectiveTransform(srcTri, dstTri);
        let warped = new cv.Mat();
        cv.warpPerspective(original, warped, M, new cv.Size(size, size), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

        // Optionally draw grid lines (for debugging)
        //drawGrid(warped, size);

        // Clean up intermediate Mats
        src.delete();
        original.delete();
        contours.delete();
        hierarchy.delete();
        approx.delete();
        srcTri.delete();
        dstTri.delete();
        M.delete();

        // Run OCR on each cell to extract digits
        const recognizedBoard = await extractDigitsFromWarped(warped);
        warped.delete();
        return recognizedBoard;
    } catch (error) {
        throw new Error("Failed to process image: " + error.message);
    }
}

function drawGrid(image, size = 450) {
    const step = size / 9;
    for (let i = 1; i < 9; i++) {
        let x = i * step;
        cv.line(image, new cv.Point(x, 0), new cv.Point(x, size), [255, 0, 0, 255], 1);
        cv.line(image, new cv.Point(0, x), new cv.Point(size, x), [255, 0, 0, 255], 1);
    }
}

function sortCorners(corners) {
    corners.sort((a, b) => a.y - b.y);
    const top = corners.slice(0, 2).sort((a, b) => a.x - b.x);
    const bottom = corners.slice(2, 4).sort((a, b) => a.x - b.x);
    return [top[0], top[1], bottom[1], bottom[0]];
}

async function extractDigitsFromWarped(warpedMat) {
    const startTime = performance.now();

    // Convert warped image to grayscale and binarize
    let gray = warpedMat.clone();
    cv.cvtColor(gray, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.threshold(gray, gray, 150, 255, cv.THRESH_BINARY_INV);

    // Apply morphological closing to reduce noise
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(gray, gray, cv.MORPH_CLOSE, kernel);

    const cellSize = 50;
    const margin = 5;
    const recognizedBoard = Array.from({ length: 9 }, () => Array(9).fill(0));

    // Process each of the 81 cells individually
    for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 9; col++) {
        const x = col * cellSize + margin;
        const y = row * cellSize + margin;
        const width = cellSize - 2 * margin;
        const height = cellSize - 2 * margin;
        const cellROI = gray.roi(new cv.Rect(x, y, width, height));

        // Use an offscreen canvas to pass cell image data to Tesseract
        const cellCanvas = document.createElement("canvas");
        cellCanvas.width = cellROI.cols;
        cellCanvas.height = cellROI.rows;
        cv.imshow(cellCanvas, cellROI);

        // OCR configuration: treat each cell as a single character
        let result = await Tesseract.recognize(cellCanvas, "eng", {
            tessedit_char_whitelist: "0123456789",
            tessedit_pageseg_mode: 10,
            tessedit_char_blacklist: "abcdefghijklmnopqrstuvwxyz",
        });
        let text = result.data.text.replace(/\D/g, "");
        if (text.length === 1 && parseInt(result.data.confidence) > 50) {
            recognizedBoard[row][col] = parseInt(text);
        }
        cellROI.delete();
        }
    }
        const endTime = performance.now();  // Add end time measurement
        const timeElapsed = endTime - startTime;
        console.log(`Digit recognition completed in ${timeElapsed.toFixed(2)/1000} seconds`);
    gray.delete();
    return recognizedBoard;
}

document.addEventListener("DOMContentLoaded", () => {
    const board = document.getElementById("sudoku-board");
    const solveButton = document.getElementById("solve-button");
    const resetButton = document.getElementById("reset-button");
    const photoInput = document.getElementById("sudoku-photo");
    const previewContainer = document.getElementById("image-preview-container");
    imagePreview = document.getElementById("image-preview");
    const resetPhotoButton = document.getElementById("reset-photo-button");
    const submitPhotoButton = document.getElementById("submit-photo-button");
    let initialNumbers = new Set();
    processingStatus = document.getElementById("processing-status");
    progressFill = document.querySelector(".progress-fill");

    imagePreview.addEventListener("load", () => {
        imageLoaded = true;
    });

    function createGrid() {
        board.innerHTML = "";
        for (let i = 0; i < 81; i++) {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "cell";
        input.min = 1;
        input.max = 9;
        input.addEventListener("input", (e) => {
            let value = e.target.value;
            if (value.length > 1) e.target.value = value.slice(-1);
            if (+value < 1 || +value > 9) e.target.value = "";
        });
        board.appendChild(input);
        }
    }
    createGrid();

    photoInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) {
            console.log('Photo selected:', file.name);

            const reader = new FileReader();
            reader.onload = (e) => {
            imagePreview.src = e.target.result;
            previewContainer.classList.remove("hidden");
            console.log('Preview shown');

        };
        reader.readAsDataURL(file);
        }
    });

    resetPhotoButton.addEventListener("click", () => {
        imagePreview.src = "";
        previewContainer.classList.add("hidden");
        photoInput.value = "";
    });

    function updateBoard(boardData) {
        const cells = document.querySelectorAll(".cell");
        cells.forEach((cell, index) => {
        const row = Math.floor(index / 9);
        const col = index % 9;
        cell.value = boardData[row][col] || "";
        });
    }

    function uploadBoard(recognizedBoard) {
        const cells = document.querySelectorAll(".cell");
        cells.forEach((cell, index) => {
        const row = Math.floor(index / 9);
        const col = index % 9;
        cell.value = recognizedBoard[row][col] || "";
        if (!initialNumbers.has(index)) {
            cell.style.color = "black";
        }
        cell.disabled = true;
        });
    }

    submitPhotoButton.addEventListener("click", async () => {
        try {
            if (!openCvReady) throw new Error("Please wait for OpenCV to load");
            console.log('Submit button clicked');

            // Show processing status
            processingStatus.classList.remove("hidden");
            progressFill.style.width = "0%";
            
            let progress = 0;
            const progressInterval = setInterval(() => {
                progress += 1;
                if (progress <= 90) {  // Only go up to 90% until actual completion
                    progressFill.style.width = `${progress}%`;
                }
            }, 50);
            
            const recognizedBoard = await recognizeSudokuFromImage();

            clearInterval(progressInterval);
            progressFill.style.width = "100%";
            setTimeout(() => {
                processingStatus.classList.add("hidden");
            }, 500);

            if (recognizedBoard) {
                uploadBoard(recognizedBoard);
                console.log("Sudoku recognized:", recognizedBoard);
            } else {
                console.error("Sudoku recognition failed.");
            }
        } catch (err) {
            console.error("Error processing image:", err);
            document.getElementById("error-message").textContent = err.message;
            document.getElementById("error-message").classList.remove("hidden");
        }
    });

    function getBoardState() {
        const cells = document.querySelectorAll(".cell");
        const boardData = Array.from({ length: 9 }, () => Array(9).fill(0));
        cells.forEach((cell, index) => {
        const row = Math.floor(index / 9);
        const col = index % 9;
        boardData[row][col] = cell.value ? parseInt(cell.value) : 0;
        });
        return boardData;
    }

    function solveSudoku(board) {
        for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 9; col++) {
            if (board[row][col] === 0) {
            for (let num = 1; num <= 9; num++) {
                if (isValid(board, row, col, num)) {
                board[row][col] = num;
                if (solveSudoku(board)) return true;
                board[row][col] = 0;
                }
            }
            return false;
            }
        }
        }
        return true;
    }

    function isValid(board, row, col, num) {
        for (let x = 0; x < 9; x++) {
        if (board[row][x] === num || board[x][col] === num) return false;
        }
        const startRow = row - (row % 3),
        startCol = col - (col % 3);
        for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            if (board[startRow + i][startCol + j] === num) return false;
        }
        }
        return true;
    }

    solveButton.addEventListener("click", () => {
        try {
        document.getElementById("error-message").classList.add("hidden");
        const cells = document.querySelectorAll(".cell");
        cells.forEach((cell, index) => {
            if (cell.value) {
            initialNumbers.add(index);
            cell.style.color = "blue";
            }
        });
        const currentBoard = getBoardState();
        if (!isValidBoard(currentBoard)) throw new Error("Invalid board!");
        if (solveSudoku(currentBoard)) {
            updateBoard(currentBoard);
            resetButton.classList.remove("hidden");
        } else {
            throw new Error("Sudoku not solvable!");
        }
        } catch (error) {
        document.getElementById("error-message").textContent = error.message;
        document.getElementById("error-message").classList.remove("hidden");
        }
    });

    resetButton.addEventListener("click", () => {
        createGrid();
        initialNumbers.clear();
        solveButton.disabled = false;
        resetButton.classList.add("hidden");
    });

    function isValidBoard(board) {
        const hasDuplicates = (arr) => {
        const nums = arr.filter((n) => n !== 0);
        return new Set(nums).size !== nums.length;
        };

        for (let i = 0; i < 9; i++) {
        const row = board[i];
        const col = board.map((r) => r[i]);
        const box = board
            .slice(Math.floor(i / 3) * 3, Math.floor(i / 3) * 3 + 3)
            .flatMap((r) => r.slice((i % 3) * 3, (i % 3) * 3 + 3));
        if (hasDuplicates(row) || hasDuplicates(col) || hasDuplicates(box)) return false;
        }
        return true;
    }
});
