
let openCvReady = false;
let imagePreview = null;
let imageLoaded = false;


function onOpenCvReady() {
    console.log("OpenCV is ready");
    openCvReady = true;
    document.getElementById('opencv-loading').classList.add('hidden');
}

window.onload = function() {
    // Debug check if OpenCV is loaded
    if (typeof cv !== 'undefined') {
        console.log("OpenCV was already loaded");
        onOpenCvReady();
    } else {
        console.log("Waiting for OpenCV...");
    }
};

async function recognizeSudokuFromImage() {
    // Validate that the image is loaded
    if (!imageLoaded || !imagePreview || !imagePreview.complete || !imagePreview.naturalHeight) {
        throw new Error("Image not loaded");
    }
    
    // Create an offscreen canvas and draw the image on it
    const canvas = document.createElement("canvas");
    canvas.width = imagePreview.naturalWidth;
    canvas.height = imagePreview.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imagePreview, 0, 0);
    
    try {
        // Read the image from the canvas
        let src = cv.imread(canvas);
        cv.resize(src, src, new cv.Size(450, 450), 0, 0, cv.INTER_AREA);

        // Clone for later use in warping
        let original = src.clone();
        
        // Preprocess the image: convert to grayscale, blur, and threshold
        cv.cvtColor(src, src, cv.COLOR_RGBA2GRAY, 0);
        let ksize = new cv.Size(5, 5);
        cv.GaussianBlur(src, src, ksize, 0, 0, cv.BORDER_DEFAULT);
        cv.adaptiveThreshold(src, src, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 11, 2);
        
        // Find contours
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        cv.findContours(src, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        
        // Select the largest contour, assuming it's the Sudoku grid
        let maxArea = 0, sudokuContour = null;
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
        
        // Approximate the contour to get a 4-point polygon
        let peri = cv.arcLength(sudokuContour, true);
        let approx = new cv.Mat();
        cv.approxPolyDP(sudokuContour, approx, 0.02 * peri, true);
        if (approx.rows !== 4) {
            throw new Error("Could not detect a proper 4-corner Sudoku grid.");
        }
        
        // Extract and sort the corners
        let corners = [];
        for (let i = 0; i < 4; i++) {
            corners.push({
                x: approx.intPtr(i, 0)[0],
                y: approx.intPtr(i, 0)[1]
            });
        }
        corners = sortCorners(corners);
        
        // Warp the perspective to a fixed 450x450 image
        const size = 450;
        let dstSize = new cv.Size(size, size);
        let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            corners[0].x, corners[0].y,
            corners[1].x, corners[1].y,
            corners[2].x, corners[2].y,
            corners[3].x, corners[3].y
        ]);
        let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0,
            size, 0,
            size, size,
            0, size
        ]);
        let M = cv.getPerspectiveTransform(srcTri, dstTri);
        let warped = new cv.Mat();
        cv.warpPerspective(original, warped, M, dstSize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
        
        // Optionally, draw a grid overlay to debug the cell boundaries
        drawGrid(warped, size);
        
        // Clean up Mats that are no longer needed
        src.delete(); 
        original.delete(); 
        contours.delete(); 
        hierarchy.delete(); 
        approx.delete();
        srcTri.delete(); 
        dstTri.delete(); 
        M.delete();
        
        // Extract digits from each cell using OCR
        const recognizedBoard = await extractDigitsFromWarped(warped);
        warped.delete();
        
        return recognizedBoard;
    } catch (error) {
        throw new Error("Failed to process image: " + error.message);
    }
}

function drawGrid(image, size = 450) {
    let step = size / 9;
    for (let i = 1; i < 9; i++) {
        let x = i * step;
        cv.line(image, new cv.Point(x, 0), new cv.Point(x, size), [255, 0, 0, 255], 1);
        cv.line(image, new cv.Point(0, x), new cv.Point(size, x), [255, 0, 0, 255], 1);
    }
}

function sortCorners(corners) {
    corners.sort((a, b) => a.y - b.y);
    let top = corners.slice(0, 2).sort((a, b) => a.x - b.x);
    let bottom = corners.slice(2, 4).sort((a, b) => a.x - b.x);
    return [top[0], top[1], bottom[1], bottom[0]];
}

async function extractDigitsFromWarped(warpedMat) {
    const startTime = performance.now();

    let gray = warpedMat.clone();
    cv.cvtColor(gray, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.threshold(gray, gray, 150, 255, cv.THRESH_BINARY_INV);

    // Morphological operations to improve OCR accuracy
    let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(gray, gray, cv.MORPH_CLOSE, kernel);

    let cellSize = 50;
    let recognizedBoard = Array.from({ length: 9 }, () => Array(9).fill(0));

    for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 9; col++) {
            let x = col * cellSize;
            let y = row * cellSize;
            let margin = 5;
            let cellROI = gray.roi(new cv.Rect(x + margin, y + margin, cellSize - 2 * margin, cellSize - 2 * margin));
            
            let cellCanvas = document.createElement('canvas');
            cellCanvas.width = cellROI.cols;
            cellCanvas.height = cellROI.rows;
            cv.imshow(cellCanvas, cellROI);

            // OCR with confidence filtering
            let result = await Tesseract.recognize(cellCanvas, 'eng', {
                tessedit_char_whitelist: '0123456789',
                tessedit_pageseg_mode: 10, // Treat each cell as a single character
                tessedit_char_blacklist: 'abcdefghijklmnopqrstuvwxyz',
            });
            let text = result.data.text.replace(/\D/g, ""); // Remove non-digit characters
            
            if (text.length === 1 && parseInt(result.data.confidence) > 50) { 
                recognizedBoard[row][col] = parseInt(text);
            }

            cellROI.delete();
        }
    }
    gray.delete();

    const endTime = performance.now();  // Add end time measurement
    const timeElapsed = endTime - startTime;
    console.log(`Digit recognition completed in ${timeElapsed.toFixed(2)/1000} seconds`);
    

    return recognizedBoard;
}


document.addEventListener('DOMContentLoaded', function() {
    const board = document.getElementById('sudoku-board');
    const solveButton = document.getElementById('solve-button');
    const resetButton = document.getElementById('reset-button');
    let initialNumbers = new Set();

    const photoInput = document.getElementById('sudoku-photo');
    const previewContainer = document.getElementById('image-preview-container');
    imagePreview = document.getElementById('image-preview');
    const resetPhotoButton = document.getElementById('reset-photo-button');
    const submitPhotoButton = document.getElementById('submit-photo-button');

    imagePreview.addEventListener('load', function() {
        imageLoaded = true;
    });

    // Create the sudoku grid
    function createGrid() {
        board.innerHTML = '';
        for (let i = 0; i < 81; i++) {
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'cell';
            input.min = 1;
            input.max = 9;
            input.addEventListener('input', function(e) {
                if (e.target.value.length > 1) {
                    e.target.value = e.target.value.slice(-1);
                }
                if (e.target.value < 1 || e.target.value > 9) {
                    e.target.value = '';
                }
            });
            board.appendChild(input);
        }
    }
    createGrid();

    photoInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            console.log('Photo selected:', file.name);
            const reader = new FileReader();
            reader.onload = function(e) {
                imagePreview.src = e.target.result;
                previewContainer.classList.remove('hidden');
                console.log('Preview shown');
            };
            reader.readAsDataURL(file);
        }
    });

    resetPhotoButton.addEventListener('click', function() {
        imagePreview.src = '';
        previewContainer.classList.add('hidden');
        photoInput.value = '';
        console.log('Photo reset');
    });

    
    // Shows the solution after pressing the solve button
    function updateBoard(boardData) {
        const cells = document.querySelectorAll('.cell');
        cells.forEach((cell, index) => {
            const row = Math.floor(index / 9);
            const col = index % 9;
            cell.value = boardData[row][col] === 0 ? "" : boardData[row][col];
        });
    }

    // Uploads the board recognized from the image
    function uploadBoard(solvedBoard) {
        const cells = document.querySelectorAll('.cell');
        cells.forEach((cell, index) => {
            const row = Math.floor(index / 9);
            const col = index % 9;
            // Only set a value if it's not 0
            cell.value = solvedBoard[row][col] === 0 ? "" : solvedBoard[row][col];
            if (!initialNumbers.has(index)) {
                cell.style.color = 'black';
            }
            cell.disabled = true;
        });
    }

    submitPhotoButton.addEventListener('click', async function() {
        try {
            if (!openCvReady) {
                throw new Error('Please wait for OpenCV to load');
            }
            console.log('Submit button clicked');
            const recognizedBoard = await recognizeSudokuFromImage();
            if (recognizedBoard) {
                uploadBoard(recognizedBoard);
                console.log('Sudoku recognized:', recognizedBoard);

            } else {
                console.error("Sudoku recognition failed.");
                return;
            }
            
        } catch (err) {
            console.error("Error processing image:", err);
            document.getElementById('error-message').textContent = err.message;
            document.getElementById('error-message').classList.remove('hidden');
    
        }
    });

    // Get current board state
    function getBoardState() {
        const cells = document.querySelectorAll('.cell');
        const board = Array(9).fill().map(() => Array(9).fill(0));
        
        cells.forEach((cell, index) => {
            const row = Math.floor(index / 9);
            const col = index % 9;
            board[row][col] = cell.value ? parseInt(cell.value) : 0;
        });
        
        return board;
    }

    // Solve Sudoku function
    function solveSudoku(board) {
        for (let row = 0; row < 9; row++) {
            for (let col = 0; col < 9; col++) {
                if (board[row][col] === 0) {
                    for (let num = 1; num <= 9; num++) {
                        if (isValid(board, row, col, num)) {
                            board[row][col] = num;
                            if (solveSudoku(board)) {
                                return true;
                            }
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
        // Check row
        for (let x = 0; x < 9; x++) {
            if (board[row][x] === num) return false;
        }

        // Check column
        for (let x = 0; x < 9; x++) {
            if (board[x][col] === num) return false;
        }

        // Check box
        let startRow = row - row % 3;
        let startCol = col - col % 3;
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                if (board[i + startRow][j + startCol] === num) return false;
            }
        }

        return true;
    }

    


    const errorMessage = document.getElementById('error-message');

    // Event Listeners
    solveButton.addEventListener('click', function() {

        try {
            errorMessage.classList.add('hidden');
            const cells = document.querySelectorAll('.cell');
            cells.forEach((cell, index) => {
                if (cell.value) {
                    initialNumbers.add(index);
                    cell.style.color = 'blue';
                }
            });
        
            const currentBoard = getBoardState();
            if (solveSudoku(currentBoard)) {
                updateBoard(currentBoard);
                resetButton.classList.remove('hidden');
            } else {
                errorMessage.textContent = "Sudoku not solvable!";
                errorMessage.classList.remove('hidden');
            }
        } catch (error) {
            errorMessage.textContent = "Sudoku not solvable!";
            errorMessage.classList.remove('hidden');
        }

        if (!isValidBoard(currentBoard)) {
            errorMessage.textContent = "Invalid board!";
            errorMessage.classList.remove('hidden');
            return;
        }
    });

    resetButton.addEventListener('click', function() {
        createGrid();
        initialNumbers.clear();
        solveButton.classList.remove('hidden');
        resetButton.classList.add('hidden');
    });

    // Initialize the grid
    createGrid();


    function isValidBoard(board) {
        function hasDuplicates(arr) {
            let nums = arr.filter(n => n !== 0);
            return new Set(nums).size !== nums.length;
        }
    
        for (let i = 0; i < 9; i++) {
            let row = board[i];
            let col = board.map(r => r[i]);
            let box = board.slice(Math.floor(i / 3) * 3, Math.floor(i / 3) * 3 + 3)
                            .flatMap(r => r.slice((i % 3) * 3, (i % 3) * 3 + 3));
            if (hasDuplicates(row) || hasDuplicates(col) || hasDuplicates(box)) {
                return false;
            }
        }
        return true;
    }
});
