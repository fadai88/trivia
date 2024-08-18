const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

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
    .then(() => {
      console.log('Connected to MongoDB');
      insertSampleQuestions();
    })
    .catch(err => console.error('Could not connect to MongoDB', err));

const Quiz = mongoose.model('Quiz', new mongoose.Schema({
    question: String,
    options: [String],
    correctAnswer: Number
}));

async function insertSampleQuestions() {
  try {
    const count = await Quiz.countDocuments();
    if (count === 0) {
      const sampleQuestions = [
        {
          question: "What is the capital of France?",
          options: ["London", "Berlin", "Paris", "Madrid"],
          correctAnswer: 2
        },
        {
          question: "Which planet is known as the Red Planet?",
          options: ["Venus", "Mars", "Jupiter", "Saturn"],
          correctAnswer: 1
        },
        {
          question: "What is 2 + 2?",
          options: ["3", "4", "5", "6"],
          correctAnswer: 1
        },
        {
          question: "Who painted the Mona Lisa?",
          options: ["Van Gogh", "Da Vinci", "Picasso", "Rembrandt"],
          correctAnswer: 1
        },
        {
          question: "What is the largest ocean on Earth?",
          options: ["Atlantic", "Indian", "Arctic", "Pacific"],
          correctAnswer: 3
        },
        {
          question: "Which country is home to the kangaroo?",
          options: ["New Zealand", "South Africa", "Australia", "Brazil"],
          correctAnswer: 2
        }
      ];

      await Quiz.insertMany(sampleQuestions);
      console.log('Sample questions inserted successfully');
    } else {
      console.log('Questions already exist in the database');
    }
  } catch (error) {
    console.error('Error inserting sample questions:', error);
  }
}

const gameRooms = new Map();

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('joinGame', (username) => {
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

  socket.on('submitAnswer', ({ roomId, answer }) => {
    console.log(`Answer submitted by ${socket.id} in room ${roomId}: answer ${answer}`);
    const room = gameRooms.get(roomId);
    if (!room) {
      console.log(`Room ${roomId} not found`);
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player) {
      console.log(`Player ${socket.id} not found in room ${roomId}`);
      return;
    }

    const question = room.questions[room.currentQuestionIndex];
    if (!question) {
      console.log(`Question ${room.currentQuestionIndex} not found in room ${roomId}`);
      return;
    }

    if (answer === question.correctAnswer) {
      player.score += 1;
      console.log(`Player ${player.username} score increased to ${player.score}`);
    }

    room.answersReceived += 1;

    if (room.answersReceived === room.players.length) {
      io.to(roomId).emit('scoreUpdate', room.players);
      room.currentQuestionIndex += 1;
      room.answersReceived = 0;

      if (room.currentQuestionIndex < room.questions.length) {
        io.to(roomId).emit('nextQuestion', {
          question: room.questions[room.currentQuestionIndex].question,
          options: room.questions[room.currentQuestionIndex].options,
          questionNumber: room.currentQuestionIndex + 1,
          totalQuestions: room.questions.length
        });
      } else {
        console.log(`Game over in room ${roomId}`);
        io.to(roomId).emit('gameOver', room.players);
        gameRooms.delete(roomId);
      }
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

  try {
    room.questions = await Quiz.aggregate([{ $sample: { size: 4 } }]);
    console.log(`Fetched ${room.questions.length} questions for room ${roomId}`);
    io.to(roomId).emit('gameStart', { players: room.players, questionCount: room.questions.length });
    io.to(roomId).emit('nextQuestion', {
      question: room.questions[0].question,
      options: room.questions[0].options,
      questionNumber: 1,
      totalQuestions: room.questions.length
    });
    console.log(`Game started in room ${roomId}`);
  } catch (error) {
    console.error('Error starting game:', error);
    io.to(roomId).emit('gameError', 'Failed to start the game. Please try again.');
  }
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));