document.addEventListener('DOMContentLoaded', function() {
    const board = document.getElementById('sudoku-board');
    const solveButton = document.getElementById('solve-button');
    const resetButton = document.getElementById('reset-button');
    let initialNumbers = new Set();

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

    // Display solved thingie
    function updateBoard(solvedBoard) {
        const cells = document.querySelectorAll('.cell');
        cells.forEach((cell, index) => {
            const row = Math.floor(index / 9);
            const col = index % 9;
            cell.value = solvedBoard[row][col];
            if (!initialNumbers.has(index)) {
                cell.style.color = 'black';
            }
            cell.disabled = true;
        });
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
    });

    resetButton.addEventListener('click', function() {
        createGrid();
        initialNumbers.clear();
        solveButton.classList.remove('hidden');
        resetButton.classList.add('hidden');
    });

    // Initialize the grid
    createGrid();
});