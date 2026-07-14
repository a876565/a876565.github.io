/**
 * OpenCV.js 模板匹配封装
 *
 * 提供 `highestSimilarity(source, template)` 异步接口，
 * 底层使用 OpenCV 的 cv.matchTemplate + cv.minMaxLoc。
 */

/**
 * 等待 OpenCV.js 运行时初始化完成
 * @returns {Promise<void>}
 */
function waitForOpenCV() {
    return new Promise((resolve, reject) => {
        if (typeof cv === 'undefined') {
            reject(new Error('OpenCV.js 未加载'));
            return;
        }
        if (cv.getBuildInformation) {
            // 已经初始化完成
            resolve();
            return;
        }
        cv['onRuntimeInitialized'] = () => {
            resolve();
        };
        // 部分构建不会触发 onRuntimeInitialized，兜底检查
        const check = setInterval(() => {
            if (cv.getBuildInformation) {
                clearInterval(check);
                resolve();
            }
        }, 50);
        // 30 秒超时
        setTimeout(() => {
            clearInterval(check);
            reject(new Error('OpenCV.js 初始化超时'));
        }, 30000);
    });
}

/**
 * 将 ImageData 转换为 OpenCV Mat（CV_8UC4）
 * @param {ImageData} imageData
 * @returns {cv.Mat}
 */
function imageDataToMat(imageData) {
    return cv.matFromImageData(imageData);
}

/**
 * 创建 OpenCV 匹配器
 * @returns {Promise<{highestSimilarity: Function}>}
 */
export async function createOpenCvMatcher() {
    await waitForOpenCV();

    return {
        /**
         * 在 source 中查找与 template 最相似的位置
         * @param {ImageData} sourceData
         * @param {ImageData} templateData
         * @returns {Promise<{location: {x: number, y: number}, similarity: number}>}
         */
        highestSimilarity(sourceData, templateData) {
            return new Promise((resolve, reject) => {
                try {
                    if (sourceData.width < templateData.width || sourceData.height < templateData.height) {
                        resolve({ location: { x: 0, y: 0 }, similarity: 0 });
                        return;
                    }

                    const src = imageDataToMat(sourceData);
                    const tpl = imageDataToMat(templateData);
                    const resultCols = sourceData.width - templateData.width + 1;
                    const resultRows = sourceData.height - templateData.height + 1;
                    const result = new cv.Mat(resultRows, resultCols, cv.CV_32FC1);

                    cv.matchTemplate(src, tpl, result, cv.TM_CCOEFF_NORMED);

                    const minMax = cv.minMaxLoc(result);
                    const similarity = minMax.maxVal;
                    const location = {
                        x: minMax.maxLoc.x,
                        y: minMax.maxLoc.y
                    };

                    src.delete();
                    tpl.delete();
                    result.delete();

                    resolve({ location, similarity });
                } catch (err) {
                    reject(err);
                }
            });
        }
    };
}
