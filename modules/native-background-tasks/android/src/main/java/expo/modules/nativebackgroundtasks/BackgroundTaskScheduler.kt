package expo.modules.nativebackgroundtasks

import android.content.Context
import androidx.work.Data
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.UUID

object BackgroundTaskScheduler {
    private const val QUEUE_NAME = "lnreader-background-task-queue"
    const val TASK_ID = "taskId"

    suspend fun enqueue(context: Context, taskId: String): UUID {
        val task = BackgroundTaskDatabase.get(context).tasks().get(taskId)
            ?: throw IllegalArgumentException("Unknown background task: $taskId")
        val requestBuilder = OneTimeWorkRequestBuilder<LNReaderTaskWorker>()
            .setInputData(Data.Builder().putString(TASK_ID, taskId).build())
            .addTag(taskId)
        if (task.type in NETWORK_TASKS) {
            requestBuilder.setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
        }
        val request = requestBuilder.build()
        BackgroundTaskDatabase.get(context).tasks()
            .assignWork(taskId, request.id.toString(), System.currentTimeMillis())
        WorkManager.getInstance(context).enqueueUniqueWork(
            QUEUE_NAME,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request,
        )
        return request.id
    }

    suspend fun enqueueLibraryUpdate(
        context: Context,
        title: String,
        description: String,
    ): UUID? {
        val dao = BackgroundTaskDatabase.get(context).tasks()
        if (dao.getActiveByType(LIBRARY_UPDATE_TASK_TYPE) != null) {
            return null
        }

        val now = System.currentTimeMillis()
        val task = BackgroundTaskEntity(
            id = UUID.randomUUID().toString(),
            type = LIBRARY_UPDATE_TASK_TYPE,
            payload = """{"name":"$LIBRARY_UPDATE_TASK_TYPE"}""",
            title = title,
            description = description,
            state = BackgroundTaskState.QUEUED,
            progress = null,
            progressText = null,
            checkpoint = null,
            attempt = 0,
            workId = null,
            createdAt = now,
            updatedAt = now,
        )
        dao.insert(task)
        return enqueue(context, task.id)
    }

    private val NETWORK_TASKS = setOf(
        LIBRARY_UPDATE_TASK_TYPE,
        "DRIVE_BACKUP",
        "DRIVE_RESTORE",
        "SELF_HOST_BACKUP",
        "SELF_HOST_RESTORE",
        "MIGRATE_NOVEL",
        "DOWNLOAD_CHAPTER",
    )

    private const val LIBRARY_UPDATE_TASK_TYPE = "UPDATE_LIBRARY"
}
