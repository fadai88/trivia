const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const moment = require('moment');
const User = require('./models/User'); // Import the User model

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Could not connect to MongoDB', err));

const Quiz = mongoose.model('Quiz', new mongoose.Schema({
    question: String,
    options: [String],
    correctAnswer: Number
}));

const gameRooms = new Map();

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    socket.on('register', async ({ username, email, password }) => {
        try {
            const user = new User({ username, email, password });
            await user.save();
            socket.emit('registrationSuccess');
        } catch (error) {
            socket.emit('registrationFailure', error.message);
        }
    });

    socket.on('login', async ({ username, password }) => {
        try {
            const user = await User.findOne({ username });
            if (user && await user.matchPassword(password)) {
                socket.emit('loginSuccess', username);
            } else {
                socket.emit('loginFailure', 'Invalid username or password');
            }
        } catch (error) {
            socket.emit('loginFailure', error.message);
        }
    });

    socket.on('joinGame', async (username) => {
        if (!username) {
            socket.emit('joinGameFailure', 'You must be logged in to join the game.');
            return;
        }

        try {
            await User.findOneAndUpdate({ username }, { $inc: { gamesPlayed: 1 } });
        } catch (error) {
            console.error('Error updating games played:', error);
        }

        console.log(`${username} (${socket.id}) is trying to join a game`);
        let roomId;
        let joinedExistingRoom = false;

        for (const [id, room] of gameRooms.entries()) {
            if (room.players.length < 2) {
                roomId = id;
                joinedExistingRoom = true;
                break;
            }
        }

        if (!roomId) {
            roomId = Math.random().toString(36).substring(7);
            gameRooms.set(roomId, { 
                players: [], 
                questions: [], 
                currentQuestionIndex: 0,
                answersReceived: 0
            });
            console.log(`Created new room: ${roomId}`);
        }

        const room = gameRooms.get(roomId);
        room.players.push({ id: socket.id, username, score: 0 });

        socket.join(roomId);
        socket.emit('gameJoined', roomId);

        console.log(`Player ${username} (${socket.id}) joined room ${roomId}`);
        console.log(`Room ${roomId} now has ${room.players.length} player(s)`);

        if (room.players.length === 2) {
            console.log(`Starting game in room ${roomId}`);
            startGame(roomId);
        } else if (joinedExistingRoom) {
            console.log(`Notifying other player in room ${roomId} that ${username} joined`);
            socket.to(roomId).emit('playerJoined', username);
        }
    });

    socket.on('submitAnswer', async ({ roomId, answer, responseTime, username }) => {
        const room = gameRooms.get(roomId);
        if (!room) return;

        const player = room.players.find(p => p.username === username);
        if (!player) return;

        const currentQuestion = room.questions[room.currentQuestionIndex];
        const isCorrect = answer === currentQuestion.correctAnswer;

        if (isCorrect) {
            player.score += 1;
            try {
                await User.findOneAndUpdate(
                    { username },
                    { 
                        $inc: { 
                            correctAnswers: 1,
                            totalPoints: 1
                        } 
                    }
                );
            } catch (error) {
                console.error('Error updating user stats:', error);
            }
        }

        player.answered = true;

        if (room.players.every(p => p.answered)) {
            completeQuestion(roomId);
        } else {
            // Emit an event to update scores for all players in the room
            io.to(roomId).emit('updateScores', room.players.map(p => ({ username: p.username, score: p.score })));
        }
    });

    socket.on('getLeaderboard', async () => {
        try {
            const leaderboard = await User.find({}, 'username correctAnswers gamesPlayed totalPoints')
                .sort({ totalPoints: -1 })
                .limit(10);
            socket.emit('leaderboardData', leaderboard);
        } catch (error) {
            console.error('Error fetching leaderboard:', error);
            socket.emit('leaderboardError', 'Failed to fetch leaderboard data');
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        for (const [roomId, room] of gameRooms.entries()) {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const disconnectedPlayer = room.players[playerIndex];
                room.players.splice(playerIndex, 1);
                console.log(`Player ${disconnectedPlayer.username} left room ${roomId}`);
                if (room.players.length === 0) {
                    console.log(`Deleting empty room ${roomId}`);
                    gameRooms.delete(roomId);
                } else {
                    console.log(`Notifying remaining player in room ${roomId}`);
                    io.to(roomId).emit('playerLeft', disconnectedPlayer.username);
                }
                break;
            }
        }
    });
});

async function startGame(roomId) {
    console.log(`Attempting to start game in room ${roomId}`);
    const room = gameRooms.get(roomId);
    if (!room) {
        console.log(`Room ${roomId} not found when trying to start game`);
        return;
    }

    room.players.forEach(player => player.score = 0);

    try {
        // Fetch 4 random questions from MongoDB
        room.questions = await Quiz.aggregate([{ $sample: { size: 7 } }]);
        console.log(`Fetched ${room.questions.length} questions for room ${roomId}`);
        io.to(roomId).emit('gameStart', { players: room.players, questionCount: room.questions.length });
        startNextQuestion(roomId);
    } catch (error) {
        console.error('Error starting game:', error);
        io.to(roomId).emit('gameError', 'Failed to start the game. Please try again.');
    }
}

function startNextQuestion(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) {
        console.log(`Room ${roomId} not found when trying to start next question`);
        return;
    }

    const currentQuestion = room.questions[room.currentQuestionIndex];
    const questionStartTime = moment();

    io.to(roomId).emit('nextQuestion', {
        question: currentQuestion.question,
        options: currentQuestion.options,
        questionNumber: room.currentQuestionIndex + 1,
        totalQuestions: room.questions.length,
        questionStartTime: questionStartTime.valueOf(),
        correctAnswerIndex: currentQuestion.correctAnswer
    });

    room.questionStartTime = questionStartTime;
    room.answersReceived = 0;

    // Clear any existing timeout
    if (room.questionTimeout) {
        clearTimeout(room.questionTimeout);
    }

    // Set a new timeout for this question
    room.questionTimeout = setTimeout(() => {
        completeQuestion(roomId);
    }, 10000); // 30 seconds for each question
}

function completeQuestion(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;

    // Reset answered status for next question
    room.players.forEach(player => player.answered = false);

    // Emit an event to update scores for all players in the room
    io.to(roomId).emit('updateScores', room.players.map(p => ({ username: p.username, score: p.score })));

    // Clear the question timeout
    if (room.questionTimeout) {
        clearTimeout(room.questionTimeout);
    }

    io.to(roomId).emit('scoreUpdate', room.players.map(p => ({ username: p.username, score: p.score })));
    room.currentQuestionIndex += 1;
    room.answersReceived = 0;

    if (room.currentQuestionIndex < room.questions.length) {
        // Add a small delay before starting the next question
        setTimeout(() => {
            startNextQuestion(roomId);
        }, 1000);
    } else {
        console.log(`Game over in room ${roomId}`);
        io.to(roomId).emit('gameOver', room.players.map(p => ({ username: p.username, score: p.score })));
        gameRooms.delete(roomId);
    }
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
