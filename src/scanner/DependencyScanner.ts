import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import * as path from 'path';
import { parseString } from 'xml2js';
import * as yauzl from 'yauzl';

const execAsync = promisify(exec);
const parseXmlAsync = promisify(parseString);

export interface ClassIndexEntry {
    className: string;
    jarPath: string;
    packageName: string;
    simpleName: string;
}

export interface ScanResult {
    jarCount: number;
    classCount: number;
    indexPath: string;
    sampleEntries: string[];
}

export class DependencyScanner {
    private indexCache: Map<string, ClassIndexEntry[]> = new Map();

    /**
     * 扫描Maven项目的所有依赖，建立类名到JAR包的映射索引
     */
    async scanProject(projectPath: string, forceRefresh: boolean = false): Promise<ScanResult> {
        const indexPath = path.join(projectPath, '.mcp-class-index.json');
        const isDebug = process.env.NODE_ENV === 'development';

        // 如果强制刷新，先删除旧的索引文件
        if (forceRefresh && await fs.pathExists(indexPath)) {
            if (isDebug) {
                console.error('强制刷新：删除旧的索引文件');
            }
            await fs.remove(indexPath);
        }

        // 检查缓存
        if (!forceRefresh && await fs.pathExists(indexPath)) {
            if (isDebug) {
                console.error('使用缓存的类索引');
            }
            const cachedIndex = await fs.readJson(indexPath);
            return {
                jarCount: cachedIndex.jarCount,
                classCount: cachedIndex.classCount,
                indexPath,
                sampleEntries: cachedIndex.sampleEntries
            };
        }

        if (isDebug) {
            console.error('开始扫描Maven依赖...');
        }

        // 1. 获取Maven依赖树
        const dependencies = await this.getMavenDependencies(projectPath);
        console.error(`找到 ${dependencies.length} 个依赖JAR包`);

        // 2. 解析每个JAR包，建立类索引
        const classIndex: ClassIndexEntry[] = [];
        let processedJars = 0;

        for (const jarPath of dependencies) {
            try {
                const classes = await this.extractClassesFromJar(jarPath);
                classIndex.push(...classes);
                processedJars++;

                if (processedJars % 10 === 0) {
                    console.error(`已处理 ${processedJars}/${dependencies.length} 个JAR包`);
                }
            } catch (error) {
                console.warn(`处理JAR包失败: ${jarPath}, 错误: ${error}`);
            }
        }

        // 3. 保存索引到文件
        const result: ScanResult = {
            jarCount: processedJars,
            classCount: classIndex.length,
            indexPath,
            sampleEntries: classIndex.slice(0, 10).map(entry =>
                `${entry.className} -> ${path.basename(entry.jarPath)}`
            )
        };

        await fs.outputJson(indexPath, {
            ...result,
            classIndex,
            lastUpdated: new Date().toISOString()
        }, { spaces: 2 });

        console.error(`扫描完成！处理了 ${processedJars} 个JAR包，索引了 ${classIndex.length} 个类`);

        return result;
    }

    /**
     * 获取Maven依赖树中的所有JAR包路径
     */
    private async getMavenDependencies(projectPath: string): Promise<string[]> {
        try {
            // 构建Maven命令路径
            const mavenCmd = this.getMavenCommand();

            // 执行 mvn dependency:tree 命令
            const { stdout } = await execAsync(`${mavenCmd} dependency:tree -DoutputType=text`, {
                cwd: projectPath,
                timeout: 60000 // 60秒超时
            });

            // 解析输出，提取JAR包路径
            const jarPaths = new Set<string>();
            const lines = stdout.split('\n');

            for (const line of lines) {
                // 匹配类似这样的行: [INFO] +- com.example:my-lib:jar:1.0.0:compile
                const match = line.match(/\[INFO\].*?([a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+)/);
                if (match) {
                    const dependency = match[1];
                    // 构建JAR包路径
                    const jarPath = await this.resolveJarPath(dependency, projectPath);
                    if (jarPath && await fs.pathExists(jarPath)) {
                        jarPaths.add(jarPath);
                    }
                }
            }

            return Array.from(jarPaths);
        } catch (error) {
            console.error('获取Maven依赖失败:', error);
            // 如果Maven命令失败，尝试从本地仓库扫描
            return await this.scanLocalMavenRepo(projectPath);
        }
    }

    /**
     * 从本地Maven仓库扫描JAR包
     */
    private async scanLocalMavenRepo(projectPath: string): Promise<string[]> {
        const mavenRepoPath = this.getMavenRepositoryPath();

        if (!await fs.pathExists(mavenRepoPath)) {
            throw new Error('Maven本地仓库不存在');
        }

        const jarFiles: string[] = [];

        const scanDir = async (dir: string) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await scanDir(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.jar')) {
                    jarFiles.push(fullPath);
                }
            }
        };

        await scanDir(mavenRepoPath);
        return jarFiles;
    }

    /**
     * 解析依赖坐标，获取JAR包路径
     */
    private async resolveJarPath(dependency: string, projectPath: string): Promise<string | null> {
        const [groupId, artifactId, type, version, scope] = dependency.split(':');

        if (type !== 'jar') {
            return null;
        }

        // 使用统一的Maven仓库路径获取方法
        const mavenRepoPath = this.getMavenRepositoryPath();
        const groupPath = groupId.replace(/\./g, '/');
        const jarPath = path.join(
            mavenRepoPath,
            groupPath,
            artifactId,
            version,
            `${artifactId}-${version}.jar`
        );

        return jarPath;
    }

    /**
     * 从JAR包中提取所有类文件信息
     */
    private async extractClassesFromJar(jarPath: string): Promise<ClassIndexEntry[]> {
        return new Promise((resolve, reject) => {
            const classes: ClassIndexEntry[] = [];

            yauzl.open(jarPath, { lazyEntries: true }, (err: any, zipfile: any) => {
                if (err) {
                    reject(err);
                    return;
                }

                zipfile.readEntry();

                zipfile.on('entry', (entry: any) => {
                    if (entry.fileName.endsWith('.class') && !entry.fileName.includes('$')) {
                        const className = entry.fileName
                            .replace(/\.class$/, '')
                            .replace(/\//g, '.');

                        const lastDotIndex = className.lastIndexOf('.');
                        const packageName = lastDotIndex > 0 ? className.substring(0, lastDotIndex) : '';
                        const simpleName = lastDotIndex > 0 ? className.substring(lastDotIndex + 1) : className;

                        classes.push({
                            className,
                            jarPath,
                            packageName,
                            simpleName
                        });
                    }

                    zipfile.readEntry();
                });

                zipfile.on('end', () => {
                    resolve(classes);
                });

                zipfile.on('error', (err: any) => {
                    reject(err);
                });
            });
        });
    }

    /**
     * 根据类名查找对应的JAR包路径
     */
    async findJarForClass(className: string, projectPath: string): Promise<string | null> {
        const indexPath = path.join(projectPath, '.mcp-class-index.json');

        if (!await fs.pathExists(indexPath)) {
            throw new Error('类索引不存在，请先运行依赖扫描');
        }

        const indexData = await fs.readJson(indexPath);
        const classIndex: ClassIndexEntry[] = indexData.classIndex;

        // 精确匹配全限定类名
        const entry = classIndex.find(entry => entry.className === className);
        if (entry) {
            return entry.jarPath;
        }

        // 模糊匹配：用 simpleName 或短类名匹配，找出候选类
        const simpleName = className.includes('.') ? className.substring(className.lastIndexOf('.') + 1) : className;
        const candidates = classIndex.filter(entry => entry.simpleName === simpleName);

        if (candidates.length === 1) {
            console.error(`未找到精确类名 ${className}，通过简单类名匹配到: ${candidates[0].className}`);
            return candidates[0].jarPath;
        } else if (candidates.length > 1) {
            const candidateNames = candidates.map(e => e.className).join(', ');
            throw new Error(
                `未找到精确类名 ${className}，但找到 ${candidates.length} 个同名类，请使用全限定类名：\n  ${candidateNames}`
            );
        }

        // 尝试包含匹配（className 包含输入值）
        const containsMatches = classIndex.filter(entry => entry.className.includes(className));
        if (containsMatches.length > 0) {
            const candidateNames = containsMatches.slice(0, 10).map(e => e.className).join('\n  ');
            const suffix = containsMatches.length > 10 ? `\n  ... 共 ${containsMatches.length} 个匹配` : '';
            throw new Error(
                `未找到类 ${className}，但找到 ${containsMatches.length} 个包含该名称的类：\n  ${candidateNames}${suffix}`
            );
        }

        return null;
    }

    /**
     * 获取所有已索引的类名
     */
    async getAllClassNames(projectPath: string): Promise<string[]> {
        const indexPath = path.join(projectPath, '.mcp-class-index.json');

        if (!await fs.pathExists(indexPath)) {
            return [];
        }

        const indexData = await fs.readJson(indexPath);
        const classIndex: ClassIndexEntry[] = indexData.classIndex;

        return classIndex.map(entry => entry.className);
    }

    /**
     * 获取Maven命令路径
     */
    private getMavenCommand(): string {
        const mavenHome = process.env.MAVEN_HOME;
        if (mavenHome) {
            const mavenCmd = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
            return path.join(mavenHome, 'bin', mavenCmd);
        }
        return 'mvn'; // 回退到PATH中的mvn
    }

    /**
     * 获取Maven本地仓库路径
     */
    private getMavenRepositoryPath(): string {
        // 1. 优先使用环境变量 MAVEN_REPO 指定的仓库路径
        const mavenRepo = process.env.MAVEN_REPO;
        if (mavenRepo) {
            return mavenRepo;
        }

        // 2. 使用默认的Maven本地仓库路径
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        return path.join(homeDir!, '.m2', 'repository');
    }
}
