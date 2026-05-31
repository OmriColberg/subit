# 🎬 כתוביות AI — Hebrew Subtitle Generator

## מבנה הפרויקט
```
subtitle-app/
├── backend/
│   ├── main.py           ← FastAPI server
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── .env              ← סודי! לא לגיט
│   └── .env.example      ← תבנית
├── frontend/
│   └── index.html
├── .gitignore
└── railway.toml
```

## הרצה מקומית
```bash
cd backend
source venv/Scripts/activate
uvicorn main:app --reload --port 8000
```

## Deploy ל-Railway
1. דחוף ל-GitHub
2. railway.app → New Project → Deploy from GitHub
3. הוסף: GEMINI_API_KEY, ALLOWED_ORIGINS
